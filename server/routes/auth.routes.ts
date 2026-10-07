import { Router } from 'express';
import dns from 'node:dns/promises';
import { prisma } from '../lib/prisma.js';
import { hashPassword, verifyPassword, isVarsayilanSifre } from '../lib/auth.js';
import { olusturOturum, oturumKapat, kullaniciOturumlariniIptalEt } from '../lib/sessions.js';
import { canAccessFirma, isYonetici } from '../lib/firmaScope.js';
/* NE: Kullanılmayan importu kaldır. NEDEN: Lint hatası.
   NASIL: Yalnız import listesini daralt. YAN ETKİ: Kimlik doğrulama değişmez. */
import { sanitizeUser, sanitizeFirma } from '../lib/sanitize.js';
import { uploadFile, decodeDataUrl, mimeToExt, MAX_PHOTO_BYTES } from '../lib/storage.js';
import { encryptPassword, verifySMTP, sendViaSMTP, SMTP_PRESETS } from '../lib/smtp.js';
import { audit, auditPrune } from '../lib/audit.js';
import { checkLoginRateLimit, getClientIp, recordLoginAttempt, resetLoginRateLimit } from '../lib/loginRateLimit.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { asyncHandler, HttpError } from '../middleware/errorHandler.js';

export const authRouter: Router = Router();

// ── POST /api/auth/login ────────────────────────────────────────
authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const ip = getClientIp(req);
    const rl = checkLoginRateLimit(ip);
    if (!rl.ok) {
      res
        .status(429)
        .json({ error: `Çok fazla başarısız giriş denemesi. ${rl.kalanSn} saniye sonra tekrar deneyiniz.` });
      return;
    }
    const body = req.body ?? {};
    const kullaniciAdi = String(body.kullaniciAdi || '')
      .trim()
      .toLocaleLowerCase('tr-TR');
    const sifre = String(body.sifre || '');
    const secilenFirmaId: string | null = body.secilenFirmaId ? String(body.secilenFirmaId) : null;
    const beniHatirla = Boolean(body.beniHatirla);

    if (!kullaniciAdi || !sifre) {
      res.status(400).json({ error: 'Kullanici adi ve sifre zorunlu.' });
      return;
    }

    // Önce TAM ad eşleşmesi; bulunamazsa ilk-kelime kısayolu ("fatih" → "fatih emre şanverdi").
    // İlk kelime BİRDEN FAZLA kullaniciya uyuyorsa belirsizlik var; tam ad iste.
    const kayitlar = await prisma.kullanici.findMany({ where: { aktifMi: true } });
    const exact = kayitlar.find(
      (u) => String(u.kullaniciAdi || '').toLocaleLowerCase('tr-TR') === kullaniciAdi,
    );
    let k = exact;
    let ambiguous = false;
    if (!k && !kullaniciAdi.includes(' ')) {
      const firstWordMatches = kayitlar.filter(
        (u) =>
          String(u.kullaniciAdi || '')
            .toLocaleLowerCase('tr-TR')
            .split(/\s+/)[0] === kullaniciAdi,
      );
      if (firstWordMatches.length === 1) {
        k = firstWordMatches[0];
      } else if (firstWordMatches.length > 1) {
        ambiguous = true;
      }
    }

    if (!k) {
      recordLoginAttempt(ip);
      if (ambiguous) {
        res.status(401).json({
          error:
            'Bu ada sahip birden fazla kullanici var. Lutfen tam adinizi girin (ornek: "fatih emre sanverdi").',
        });
        return;
      }
      res.status(401).json({ error: 'Kullanici adi veya sifre hatali.' });
      return;
    }

    if (!verifyPassword(sifre, k.sifreHash)) {
      recordLoginAttempt(ip);
      await audit('login_failed', { kullaniciId: k.id, kullaniciAdi: k.kullaniciAdi, firmaId: k.firmaId }, { reason: 'wrong_password' });
      res.status(401).json({ error: 'Kullanici adi veya sifre hatali.' });
      return;
    }

    // Firma yetkisi: seçilen firmaya erişebilir mi?
    if (secilenFirmaId && !canAccessFirma(k, secilenFirmaId)) {
      recordLoginAttempt(ip);
      await audit(
        'login_blocked',
        { kullaniciId: k.id, kullaniciAdi: k.kullaniciAdi, firmaId: k.firmaId },
        { reason: 'wrong_firma', secilenFirmaId, kullaniciFirmaId: k.firmaId },
      );
      res.status(403).json({ error: 'Bu firmaya kayitli degilsiniz. Lutfen kendi firmanizi seciniz.' });
      return;
    }

    const ua = String(req.headers['user-agent'] || '');
    const { token, expiresAt } = await olusturOturum({
      kullaniciId: k.id,
      beniHatirla,
      ip,
      ua,
    });
    await audit('login', { kullaniciId: k.id, kullaniciAdi: k.kullaniciAdi, firmaId: k.firmaId });
    resetLoginRateLimit(ip);

    const firma = k.firmaId ? await prisma.firma.findUnique({ where: { id: k.firmaId } }) : null;

    res.json({
      token,
      expiresAt: expiresAt.toISOString(),
      kullanici: sanitizeUser(k),
      firma: firma ? sanitizeFirma(firma) : null,
    });

    // Audit log boyutunu kontrol et (fire-and-forget)
    auditPrune().catch(() => {});
  }),
);

// ── POST /api/auth/logout ───────────────────────────────────────
authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const raw = req.headers['x-session-token'];
    const token = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : '';
    if (token) await oturumKapat(token);
    res.json({ ok: true });
  }),
);

// ── GET /api/auth/me ────────────────────────────────────────────
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const k = req.authCtx!.kullanici;
    const firma = k.firmaId ? await prisma.firma.findUnique({ where: { id: k.firmaId } }) : null;
    res.json({
      kullanici: sanitizeUser(k),
      firma: firma ? sanitizeFirma(firma) : null,
    });
  }),
);

// ── POST /api/auth/change-password ──────────────────────────────
authRouter.post(
  '/change-password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const mevcut = String(body.mevcutSifre || '');
    const yeni = String(body.yeniSifre || '');
    if (yeni.length < 4) throw new HttpError(400, 'Yeni sifre en az 4 karakter olmali.');
    if (isVarsayilanSifre(yeni)) throw new HttpError(400, 'Yeni sifre varsayilan sifre (0000 / 1234) olamaz.');

    const k = req.authCtx!.kullanici;

    // İlk giriş akışı (mustChangePassword=true): mevcut şifre kontrolü ATLA.
    // Kullanıcı zaten geçerli bir token ile authenticated (requireAuth doğruladı);
    // ayrıca migration / reset sırasında frontend hangi default şifrenin hash'lendiğini
    // bilemediği için "1234" denemesi başarısız oluyordu. Bu state özel: kullanıcının
    // yeni şifre belirlemek zorunda olduğu zorunlu bir adım, mevcut sifre tekrar
    // sorulmaz. Normal şifre değişimlerinde (mustChangePassword=false) kontrol devam eder.
    if (!k.mustChangePassword) {
      if (!verifyPassword(mevcut, k.sifreHash)) {
        await audit(
          'change_password_failed',
          { kullaniciId: k.id, kullaniciAdi: k.kullaniciAdi, firmaId: k.firmaId },
          { reason: 'wrong_current' },
        );
        throw new HttpError(401, 'Mevcut sifre hatali.');
      }
    }

    const yeniHash = hashPassword(yeni);
    await prisma.kullanici.update({
      where: { id: k.id },
      data: {
        sifreHash: yeniHash,
        mustChangePassword: false,
        sifreDegisikligi: new Date(),
      },
    });

    // Diğer oturumları iptal — yalnız mevcut oturum kalsın
    await kullaniciOturumlariniIptalEt(k.id, req.authCtx!.oturum.token);
    await audit('change_password', { kullaniciId: k.id, kullaniciAdi: k.kullaniciAdi, firmaId: k.firmaId });
    res.json({ ok: true, mustChangePassword: false });
  }),
);

// ── POST /api/auth/upload-photo ─────────────────────────────────
authRouter.post(
  '/upload-photo',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const fotoBase64: string = String(body.fotoBase64 || '');
    if (!fotoBase64) throw new HttpError(400, 'fotoBase64 bos.');

    const { mime, buffer } = decodeDataUrl(fotoBase64);
    if (buffer.length === 0) throw new HttpError(400, 'Foto verisi gecersiz.');
    if (buffer.length > MAX_PHOTO_BYTES) {
      throw new HttpError(
        400,
        `Foto cok buyuk (${Math.round(buffer.length / 1024)} KB). Maks ${Math.round(MAX_PHOTO_BYTES / 1024)} KB.`,
      );
    }

    const k = req.authCtx!.kullanici;
    const ext = mimeToExt(mime);
    const key = `kullanicilar/${k.id}.${ext}`;
    let url: string;
    try {
      const result = await uploadFile(key, buffer, mime);
      url = result.url;
    } catch (err) {
      // R2'den AccessDenied/Forbidden gelirse kullanıcıya teşhis dostu mesaj.
      // Render env'inde R2_* yanlış/eksik veya R2 token yazma izni yoksa burada
      // takılır. Net mesaj → kullanıcı doğrudan ayarlara yönelir.
      const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number }; message?: string };
      const code = e?.Code || e?.name || '';
      const http = e?.$metadata?.httpStatusCode;
      console.error('[upload-photo] R2 yazma hatası:', { code, http, message: e?.message, key });
      if (code === 'AccessDenied' || http === 403) {
        throw new HttpError(
          502,
          'Profil fotoğrafı kaydedilemedi: R2 sunucusu yazma iznini reddetti (AccessDenied). Render ayarlarında R2 API token izni "Object Read & Write" olmalı ve R2_BUCKET adı doğru olmalı.',
        );
      }
      if (http === 404 || code === 'NoSuchBucket') {
        throw new HttpError(
          502,
          `Profil fotoğrafı kaydedilemedi: R2 bucket bulunamadı. R2_BUCKET env değerini kontrol edin.`,
        );
      }
      throw new HttpError(502, `Profil fotoğrafı kaydedilemedi: ${code || 'bilinmeyen R2 hatası'} (${http ?? '-'}).`);
    }
    const cacheBust = `${url}?v=${Date.now()}`;

    const updated = await prisma.kullanici.update({
      where: { id: k.id },
      data: {
        profilFotoUrl: cacheBust,
        profilFotoYuklemeTarihi: new Date(),
      },
    });

    await audit('profil_foto_yuklendi', { kullaniciId: k.id, kullaniciAdi: k.kullaniciAdi, firmaId: k.firmaId });
    res.json({ profilFotoUrl: cacheBust, kullanici: sanitizeUser(updated) });
  }),
);

// ── POST /api/auth/admin/upload-photo-for/:userId ─────────────────────
// Admin başka bir kullanıcının profil fotosunu güncelleyebilir.
// Yetki: super_admin → herkes; firma_admin → kendi firmasındaki kullanıcılar.
// Yüz odaklı re-processing migration için kullanılır.
authRouter.post(
  '/admin/upload-photo-for/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const requestor = req.authCtx!.kullanici;
    const isSuperAdmin = requestor.rol === 'super_admin';
    const isFirmaAdmin = requestor.rol === 'firma_admin';
    if (!isSuperAdmin && !isFirmaAdmin) {
      throw new HttpError(403, 'Bu işlem için super_admin veya firma_admin yetkisi gerekir.');
    }

    const userId = String(req.params.userId || '');
    if (!userId) throw new HttpError(400, 'userId zorunlu.');

    const target = await prisma.kullanici.findUnique({ where: { id: userId } });
    if (!target) throw new HttpError(404, 'Kullanıcı bulunamadı.');

    // firma_admin sadece kendi firmasına dokunabilir
    if (!isSuperAdmin && target.firmaId !== requestor.firmaId) {
      throw new HttpError(403, 'Bu kullanıcının firmasında yetkin yok.');
    }

    const fotoBase64: string = String(req.body?.fotoBase64 || '');
    if (!fotoBase64) throw new HttpError(400, 'fotoBase64 boş.');

    const { mime, buffer } = decodeDataUrl(fotoBase64);
    if (buffer.length === 0) throw new HttpError(400, 'Foto verisi geçersiz.');
    if (buffer.length > MAX_PHOTO_BYTES) {
      throw new HttpError(
        400,
        `Foto çok büyük (${Math.round(buffer.length / 1024)} KB). Maks ${Math.round(MAX_PHOTO_BYTES / 1024)} KB.`,
      );
    }

    const ext = mimeToExt(mime);
    const key = `kullanicilar/${target.id}.${ext}`;
    let url: string;
    try {
      const result = await uploadFile(key, buffer, mime);
      url = result.url;
    } catch (err) {
      const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number }; message?: string };
      const code = e?.Code || e?.name || '';
      const http = e?.$metadata?.httpStatusCode;
      console.error('[admin/upload-photo-for] R2 yazma hatası:', { code, http, message: e?.message, key });
      throw new HttpError(502, `Profil fotoğrafı kaydedilemedi: ${code || 'bilinmeyen R2 hatası'} (${http ?? '-'}).`);
    }
    const cacheBust = `${url}?v=${Date.now()}`;

    const updated = await prisma.kullanici.update({
      where: { id: target.id },
      data: {
        profilFotoUrl: cacheBust,
        profilFotoYuklemeTarihi: new Date(),
      },
    });

    // NE: admin_profil_foto_yuklendi audit kaydı — alan adları AuditCtx şemasına uygun hâle getirildi.
    // NEDEN: AuditCtx { kullaniciId, kullaniciAdi, firmaId } — "yapan/hedef" ayrımı YOK. Projede sabit
    //        kural: ana alanlar İŞLEMİ YAPANI tutar, hedef daima detay'a yazılır (krş. kullanici_guncellendi
    //        / sifre_sifirlandi: kullaniciId=me, detay.hedefId). Eski hâli tersti — hedefi ana alana, yapanı
    //        var olmayan yapanKullaniciId/yapanKullaniciAdi alanlarına koyuyordu → TS2561 + audit log'un
    //        kullaniciId sütunu bu tek olayda diğerleriyle tutarsız olurdu.
    // NASIL: kullaniciId/kullaniciAdi/firmaId = requestor (yapan admin); hedef kullanıcı detay'a taşındı.
    // YAN ETKİ: bu olayın satırında artık YAPAN kayıtlı (audit tutarlı); hedef bilgisi detay'da korunuyor.
    await audit(
      'admin_profil_foto_yuklendi',
      { kullaniciId: requestor.id, kullaniciAdi: requestor.kullaniciAdi, firmaId: requestor.firmaId },
      { hedefId: target.id, hedefKullaniciAdi: target.kullaniciAdi },
    );
    res.json({ profilFotoUrl: cacheBust, kullanici: sanitizeUser(updated) });
  }),
);

// ── GET /api/auth/smtp-ayarlar ──────────────────────────────────
// Kullanıcının mevcut SMTP konfigürasyonunu döner (şifre dahil DEĞİL).
authRouter.get(
  '/smtp-ayarlar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const k = req.authCtx!.kullanici;
    res.json({
      smtpHost: k.smtpHost ?? null,
      smtpPort: k.smtpPort ?? null,
      smtpSecure: k.smtpSecure ?? null,
      smtpUser: k.smtpUser ?? null,
      smtpFromName: k.smtpFromName ?? null,
      smtpFromAddress: k.smtpFromAddress ?? null,
      hasPassword: Boolean(k.smtpPasswordEncrypted),
      presets: SMTP_PRESETS,
    });
  }),
);

// ── PATCH /api/auth/smtp-ayarlar ────────────────────────────────
// Kullanıcı kendi SMTP credentials'larını günceller.
// password ya boş bırakılır (mevcut şifre korunur) ya da yeni şifre verilir.
authRouter.patch(
  '/smtp-ayarlar',
  requireAuth,
  asyncHandler(async (req, res) => {
    const k = req.authCtx!.kullanici;
    const body = req.body ?? {};
    const data: Record<string, unknown> = {};
    if ('smtpHost' in body) data.smtpHost = String(body.smtpHost || '').trim() || null;
    if ('smtpPort' in body) {
      const port = Number(body.smtpPort);
      data.smtpPort = Number.isFinite(port) && port > 0 ? Math.floor(port) : null;
    }
    if ('smtpSecure' in body) data.smtpSecure = Boolean(body.smtpSecure);
    if ('smtpUser' in body) data.smtpUser = String(body.smtpUser || '').trim() || null;
    if ('smtpFromName' in body) data.smtpFromName = String(body.smtpFromName || '').trim() || null;
    if ('smtpFromAddress' in body) data.smtpFromAddress = String(body.smtpFromAddress || '').trim() || null;
    if (typeof body.smtpPassword === 'string' && body.smtpPassword.length > 0) {
      try {
        data.smtpPasswordEncrypted = encryptPassword(body.smtpPassword);
      } catch (err) {
        throw new HttpError(500, err instanceof Error ? err.message : 'SMTP şifresi şifrelenemedi.');
      }
    }
    if ('clearPassword' in body && body.clearPassword === true) {
      data.smtpPasswordEncrypted = null;
    }
    const updated = await prisma.kullanici.update({ where: { id: k.id }, data });
    await audit('smtp_ayarlar_guncellendi', { kullaniciId: k.id, kullaniciAdi: k.kullaniciAdi, firmaId: k.firmaId });
    res.json({
      ok: true,
      smtpHost: updated.smtpHost,
      smtpPort: updated.smtpPort,
      smtpSecure: updated.smtpSecure,
      smtpUser: updated.smtpUser,
      smtpFromName: updated.smtpFromName,
      smtpFromAddress: updated.smtpFromAddress,
      hasPassword: Boolean(updated.smtpPasswordEncrypted),
    });
  }),
);

// ── POST /api/auth/smtp-test ────────────────────────────────────
// Verilen SMTP config ile bağlantı testi yapar (mail göndermez).
// Form gönderiminden ÖNCE çağrılır; password body'den gelir (henüz DB'de değil).
authRouter.post(
  '/smtp-test',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const host = String(body.smtpHost || '').trim();
    const port = Number(body.smtpPort);
    const secure = Boolean(body.smtpSecure);
    const user = String(body.smtpUser || '').trim();
    const password = String(body.smtpPassword || '');
    if (!host || !port || !user || !password) {
      throw new HttpError(400, 'SMTP host, port, user ve password zorunlu.');
    }
    const result = await verifySMTP({ host, port, secure, user, password });
    if (!result.ok) {
      res.status(400).json({ ok: false, error: result.error });
      return;
    }
    res.json({ ok: true });
  }),
);

/** Hem doğrudan domain hem de MX kaydına bakarak uygun SMTP sunucusunu tespit
 *  eder. Google Workspace (mebamekanik.com → Google MX), Yandex Mail for Domain
 *  (elmos.com.tr → Yandex MX), Microsoft 365 (custom domain → outlook.com MX)
 *  durumları otomatik çözülür. MX lookup başarısız olursa son çare olarak
 *  domain ekine bakar; o da bilinmiyorsa Office 365 varsayar. */
async function deriveSmtpFromEmail(email: string): Promise<{ host: string; port: number; secure: boolean }> {
  const domain = email.split('@')[1]?.toLowerCase() || '';
  // Doğrudan tüketici sağlayıcıları — MX lookup'a gerek yok
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return { host: 'smtp.gmail.com', port: 465, secure: true };
  }
  if (domain === 'outlook.com' || domain === 'hotmail.com' || domain === 'live.com' || domain.endsWith('.onmicrosoft.com')) {
    return { host: 'smtp.office365.com', port: 587, secure: false };
  }
  if (domain.endsWith('yandex.com') || domain.endsWith('yandex.ru') || domain.endsWith('yandex.com.tr')) {
    return { host: 'smtp.yandex.com', port: 465, secure: true };
  }
  if (domain.endsWith('zoho.com') || domain.endsWith('zoho.eu')) {
    return { host: 'smtp.zoho.com', port: 465, secure: true };
  }

  // Kurumsal domain (mebamekanik.com, elmos.com.tr vb) — MX kaydından tespit et
  try {
    const records = await dns.resolveMx(domain);
    const exchanges = records.map((r) => r.exchange.toLowerCase());
    if (exchanges.some((x) => x.includes('google.com') || x.includes('googlemail.com'))) {
      return { host: 'smtp.gmail.com', port: 465, secure: true };
    }
    if (exchanges.some((x) => x.includes('yandex.net') || x.includes('yandex.ru'))) {
      return { host: 'smtp.yandex.com', port: 465, secure: true };
    }
    if (exchanges.some((x) => x.includes('outlook.com') || x.includes('protection.outlook.com'))) {
      return { host: 'smtp.office365.com', port: 587, secure: false };
    }
    if (exchanges.some((x) => x.includes('zoho.com') || x.includes('zoho.eu'))) {
      return { host: 'smtp.zoho.com', port: 465, secure: true };
    }
  } catch {
    // DNS hatası — fallback
  }

  // Son çare: Office 365 varsayımı
  return { host: 'smtp.office365.com', port: 587, secure: false };
}

// ── GET /api/auth/admin/smtp-ayarlar/:userId ────────────────────
// Bir başka kullanıcının SMTP konfigürasyonunu döner (yönetici yetkisi ister).
// firma_admin sadece kendi firmasındaki kullanıcıları, super_admin tümünü görür.
authRouter.get(
  '/admin/smtp-ayarlar/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const me = req.authCtx!.kullanici;
    if (!isYonetici(me.rol)) throw new HttpError(403, 'Bu işlem için yönetici yetkisi gerekir.');
    const userId = String(req.params.userId || '');
    const hedef = await prisma.kullanici.findUnique({ where: { id: userId } });
    if (!hedef) throw new HttpError(404, 'Kullanıcı bulunamadı.');
    if (!hedef.firmaId || !canAccessFirma(me, hedef.firmaId)) {
      throw new HttpError(403, 'Bu kullanıcıya erişim yetkiniz yok.');
    }
    res.json({
      userId: hedef.id,
      adSoyad: hedef.adSoyad,
      kullaniciAdi: hedef.kullaniciAdi,
      smtpHost: hedef.smtpHost ?? null,
      smtpPort: hedef.smtpPort ?? null,
      smtpSecure: hedef.smtpSecure ?? null,
      smtpUser: hedef.smtpUser ?? null,
      smtpFromName: hedef.smtpFromName ?? null,
      smtpFromAddress: hedef.smtpFromAddress ?? null,
      hasPassword: Boolean(hedef.smtpPasswordEncrypted),
      presets: SMTP_PRESETS,
    });
  }),
);

// ── PATCH /api/auth/admin/smtp-ayarlar/:userId ──────────────────
// Bir başka kullanıcının SMTP konfigürasyonunu günceller (yönetici yetkisi).
// "Kolay mod": sadece email + appPassword gönderirse host/port domain'den
// türetilir, fromName = hedefin adSoyad'ı olur, fromAddress = email.
authRouter.patch(
  '/admin/smtp-ayarlar/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const me = req.authCtx!.kullanici;
    if (!isYonetici(me.rol)) throw new HttpError(403, 'Bu işlem için yönetici yetkisi gerekir.');
    const userId = String(req.params.userId || '');
    const hedef = await prisma.kullanici.findUnique({ where: { id: userId } });
    if (!hedef) throw new HttpError(404, 'Kullanıcı bulunamadı.');
    if (!hedef.firmaId || !canAccessFirma(me, hedef.firmaId)) {
      throw new HttpError(403, 'Bu kullanıcıya erişim yetkiniz yok.');
    }
    const body = req.body ?? {};
    const data: Record<string, unknown> = {};

    // Kolay mod: sadece email verilirse host/port otomatik
    const userEmail = typeof body.smtpUser === 'string' ? String(body.smtpUser).trim() : '';
    const explicitHost = 'smtpHost' in body ? String(body.smtpHost || '').trim() : '';
    if (userEmail) {
      data.smtpUser = userEmail;
      if (!explicitHost) {
        const derived = await deriveSmtpFromEmail(userEmail);
        data.smtpHost = derived.host;
        data.smtpPort = derived.port;
        data.smtpSecure = derived.secure;
      }
      // fromAddress default = smtpUser, fromName default = hedefin adSoyad'ı
      if (!('smtpFromAddress' in body)) data.smtpFromAddress = userEmail;
      if (!('smtpFromName' in body) && !hedef.smtpFromName) data.smtpFromName = hedef.adSoyad;
    }

    if (explicitHost) data.smtpHost = explicitHost;
    if ('smtpPort' in body) {
      const port = Number(body.smtpPort);
      data.smtpPort = Number.isFinite(port) && port > 0 ? Math.floor(port) : null;
    }
    if ('smtpSecure' in body) data.smtpSecure = Boolean(body.smtpSecure);
    if ('smtpFromName' in body) data.smtpFromName = String(body.smtpFromName || '').trim() || null;
    if ('smtpFromAddress' in body) data.smtpFromAddress = String(body.smtpFromAddress || '').trim() || null;

    if (typeof body.smtpPassword === 'string' && body.smtpPassword.length > 0) {
      try {
        data.smtpPasswordEncrypted = encryptPassword(body.smtpPassword);
      } catch (err) {
        throw new HttpError(500, err instanceof Error ? err.message : 'SMTP şifresi şifrelenemedi.');
      }
    }
    if ('clearPassword' in body && body.clearPassword === true) {
      data.smtpPasswordEncrypted = null;
    }

    const updated = await prisma.kullanici.update({ where: { id: userId }, data });
    await audit('admin_smtp_ayarlar_guncellendi', {
      kullaniciId: me.id,
      kullaniciAdi: `${me.kullaniciAdi} → ${hedef.kullaniciAdi}`,
      firmaId: hedef.firmaId,
    });
    res.json({
      ok: true,
      userId: updated.id,
      smtpHost: updated.smtpHost,
      smtpPort: updated.smtpPort,
      smtpSecure: updated.smtpSecure,
      smtpUser: updated.smtpUser,
      smtpFromName: updated.smtpFromName,
      smtpFromAddress: updated.smtpFromAddress,
      hasPassword: Boolean(updated.smtpPasswordEncrypted),
    });
  }),
);

// ── POST /api/auth/admin/smtp-test-mail/:userId ─────────────────
// Belirtilen kullanıcının SMTP ayarlarını gerçek bir bağlantıyla test eder
// (kullanıcının kendi adresine bir test maili gönderir).
authRouter.post(
  '/admin/smtp-test-mail/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const me = req.authCtx!.kullanici;
    if (!isYonetici(me.rol)) throw new HttpError(403, 'Bu işlem için yönetici yetkisi gerekir.');
    const userId = String(req.params.userId || '');
    const hedef = await prisma.kullanici.findUnique({ where: { id: userId } });
    if (!hedef) throw new HttpError(404, 'Kullanıcı bulunamadı.');
    if (!hedef.firmaId || !canAccessFirma(me, hedef.firmaId)) {
      throw new HttpError(403, 'Bu kullanıcıya erişim yetkiniz yok.');
    }
    if (!hedef.smtpHost || !hedef.smtpUser || !hedef.smtpPasswordEncrypted) {
      throw new HttpError(400, 'Önce kullanıcının SMTP ayarlarını kaydedin.');
    }
    const { decryptPassword } = await import('../lib/smtp.js');
    let plainPassword: string;
    try {
      plainPassword = decryptPassword(hedef.smtpPasswordEncrypted);
    } catch (err) {
      throw new HttpError(500, err instanceof Error ? err.message : 'SMTP şifresi okunamadı.');
    }
    const toAddress = hedef.smtpFromAddress || hedef.smtpUser;
    const result = await sendViaSMTP(
      {
        host: hedef.smtpHost,
        port: hedef.smtpPort ?? 587,
        secure: hedef.smtpSecure ?? true,
        user: hedef.smtpUser,
        password: plainPassword,
        fromName: hedef.smtpFromName || hedef.adSoyad,
        fromAddress: toAddress,
      },
      {
        to: toAddress,
        subject: 'Teklif Yönetim Sistemi — SMTP Test (Admin)',
        text: 'Bu bir admin test mailidir. SMTP ayarlarınız doğru çalışıyor.',
        html: '<p>Bu bir <strong>admin test maili</strong>dir. SMTP ayarlarınız doğru çalışıyor.</p>',
      },
    );
    if (!result.ok) {
      res.status(502).json({ ok: false, error: result.error });
      return;
    }
    res.json({ ok: true, to: toAddress, messageId: result.messageId });
  }),
);

// ── POST /api/auth/smtp-test-mail ───────────────────────────────
// Kullanıcının kayıtlı SMTP credentials'ları ile kendisine test maili gönderir.
authRouter.post(
  '/smtp-test-mail',
  requireAuth,
  asyncHandler(async (req, res) => {
    const k = req.authCtx!.kullanici;
    if (!k.smtpHost || !k.smtpUser || !k.smtpPasswordEncrypted) {
      throw new HttpError(400, 'Önce SMTP ayarlarınızı kaydedin.');
    }
    const { decryptPassword } = await import('../lib/smtp.js');
    let plainPassword: string;
    try {
      plainPassword = decryptPassword(k.smtpPasswordEncrypted);
    } catch (err) {
      throw new HttpError(500, err instanceof Error ? err.message : 'SMTP şifresi okunamadı.');
    }
    const toAddress = k.smtpFromAddress || k.smtpUser;
    const result = await sendViaSMTP(
      {
        host: k.smtpHost,
        port: k.smtpPort ?? 587,
        secure: k.smtpSecure ?? true,
        user: k.smtpUser,
        password: plainPassword,
        fromName: k.smtpFromName || k.adSoyad,
        fromAddress: toAddress,
      },
      {
        to: toAddress,
        subject: 'Teklif Yönetim Sistemi — SMTP Test',
        text: 'Bu bir test mailidir. SMTP ayarlarınız doğru çalışıyor.',
        html: '<p>Bu bir test mailidir. SMTP ayarlarınız <strong>doğru çalışıyor</strong>.</p>',
      },
    );
    if (!result.ok) {
      res.status(502).json({ ok: false, error: result.error });
      return;
    }
    res.json({ ok: true, to: toAddress, messageId: result.messageId });
  }),
);
