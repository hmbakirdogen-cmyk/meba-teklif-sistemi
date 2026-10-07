import { Router } from 'express';
import { paramStr } from '../lib/params.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword, getVarsayilanSifre } from '../lib/auth.js';
import { kullaniciOturumlariniIptalEt } from '../lib/sessions.js';
import { sanitizeUser, uretInitials } from '../lib/sanitize.js';
import { audit } from '../lib/audit.js';
import { requireAuth, requireAdmin } from '../middleware/requireAuth.js';
import { asyncHandler, HttpError } from '../middleware/errorHandler.js';

export const kullanicilarRouter: Router = Router();

const IZINLI_ROLLER = ['super_admin', 'firma_admin', 'engineer', 'sales'] as const;
type IzinliRol = (typeof IZINLI_ROLLER)[number];

// ── GET /api/kullanicilar ───────────────────────────────────────
kullanicilarRouter.get(
  '/',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const k = req.authCtx!.kullanici;
    let liste = await prisma.kullanici.findMany({ orderBy: { adSoyad: 'asc' } });
    if (k.rol === 'firma_admin') {
      const kapsam =
        Array.isArray(k.gosterilenFirmalar) && k.gosterilenFirmalar.length > 0
          ? k.gosterilenFirmalar
          : k.firmaId
            ? [k.firmaId]
            : [];
      liste = liste.filter((u) => u.firmaId === null || kapsam.includes(u.firmaId));
    }
    res.json(liste.map(sanitizeUser));
  }),
);

// ── POST /api/kullanicilar ──────────────────────────────────────
kullanicilarRouter.post(
  '/',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const me = req.authCtx!.kullanici;
    const body = req.body ?? {};
    const adSoyad = String(body.adSoyad || '').trim();
    const kullaniciAdi = String(body.kullaniciAdi || '')
      .trim()
      .toLocaleLowerCase('tr-TR');
    const unvan = String(body.unvan || '').trim();
    const istenenRol: IzinliRol = (IZINLI_ROLLER as readonly string[]).includes(body.rol)
      ? (body.rol as IzinliRol)
      : 'engineer';

    if (istenenRol === 'super_admin' && me.rol !== 'super_admin') {
      throw new HttpError(403, 'Süper Yönetici rolünde kullanıcı oluşturmak için Süper Yönetici yetkisi gereklidir.');
    }

    if (!adSoyad || !kullaniciAdi) {
      throw new HttpError(400, 'Ad Soyad ve kullanici adi zorunlu.');
    }

    /* NE: Firma kimliğini const yap. NEDEN: Yeniden atanmaz.
       NASIL: Bildirim türünü değiştir. YAN ETKİ: Firma doğrulaması değişmez. */
    const firmaId: string | null = body.firmaId || null;
    if (firmaId !== null && !firmaId) throw new HttpError(400, 'firmaId zorunlu.');
    if (firmaId !== null) {
      const f = await prisma.firma.findUnique({ where: { id: firmaId } });
      if (!f) throw new HttpError(400, 'Gecersiz firmaId.');
    }

    const cakisma = await prisma.kullanici.findFirst({
      where: { kullaniciAdi: { equals: kullaniciAdi, mode: 'insensitive' } },
    });
    if (cakisma) throw new HttpError(409, 'Bu kullanici adi zaten kullanimda.');

    const yeniId = 'u-' + Math.random().toString(36).slice(2, 10);
    const varsayilanSifre = getVarsayilanSifre(istenenRol);
    const yeni = await prisma.kullanici.create({
      data: {
        id: yeniId,
        kullaniciAdi,
        sifreHash: hashPassword(varsayilanSifre),
        adSoyad,
        unvan,
        initials: uretInitials(adSoyad),
        rol: istenenRol,
        firmaId,
        telefon: String(body.telefon || '').trim(),
        dahili: String(body.dahili || '').trim(),
        aktifMi: true,
        mustChangePassword: true,
        olusturanKullaniciId: me.id,
      },
    });

    await audit(
      'kullanici_olusturuldu',
      { kullaniciId: me.id, kullaniciAdi: me.kullaniciAdi, firmaId: me.firmaId },
      { yeniKullaniciId: yeni.id, firmaId },
    );
    res.json({ kullanici: sanitizeUser(yeni), varsayilanSifre });
  }),
);

// ── PATCH /api/kullanicilar/:id ─────────────────────────────────
kullanicilarRouter.patch(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const me = req.authCtx!.kullanici;
    const id = paramStr(req, 'id');
    const target = await prisma.kullanici.findUnique({ where: { id } });
    if (!target) throw new HttpError(404, 'Kullanici bulunamadi.');

    const isSelf = target.id === me.id;
    const meRol = me.rol;
    const targetIsSuperAdmin = target.rol === 'super_admin';
    let canEdit = false;
    if (isSelf) canEdit = true;
    else if (meRol === 'super_admin') canEdit = true;
    else if (meRol === 'firma_admin' && !targetIsSuperAdmin) canEdit = true;
    if (!canEdit) throw new HttpError(403, 'Bu kullaniciyi guncelleyemezsiniz.');

    const isAdmin = !isSelf && canEdit;
    const body = req.body ?? {};
    const data: Record<string, unknown> = {};
    const selfIzin = ['adSoyad', 'unvan', 'unvanCinsiyet', 'initials', 'telefon', 'dahili'];
    const adminEk = ['rol', 'aktifMi', 'gosterilenFirmalar', 'firmaId'];
    const izinli = isAdmin ? [...selfIzin, ...adminEk] : selfIzin;
    for (const alan of izinli) {
      if (alan in body) data[alan] = body[alan];
    }
    if (data.adSoyad && !data.initials) data.initials = uretInitials(String(data.adSoyad));

    const updated = await prisma.kullanici.update({ where: { id }, data });
    await audit(
      'kullanici_guncellendi',
      { kullaniciId: me.id, kullaniciAdi: me.kullaniciAdi, firmaId: me.firmaId },
      { hedefId: id, alanlar: Object.keys(data) },
    );
    res.json(sanitizeUser(updated));
  }),
);

// ── POST /api/kullanicilar/:id/sifre-sifirla ────────────────────
kullanicilarRouter.post(
  '/:id/sifre-sifirla',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const me = req.authCtx!.kullanici;
    const id = paramStr(req, 'id');
    const target = await prisma.kullanici.findUnique({ where: { id } });
    if (!target) throw new HttpError(404, 'Kullanici bulunamadi.');
    if (me.rol !== 'super_admin' && target.rol === 'super_admin') {
      throw new HttpError(403, 'Süper Yöneticinin şifresini sıfırlamak için Süper Yönetici yetkisi gereklidir.');
    }
    const varsayilanSifre = getVarsayilanSifre(target.rol);
    await prisma.kullanici.update({
      where: { id },
      data: {
        sifreHash: hashPassword(varsayilanSifre),
        mustChangePassword: true,
        sifreDegisikligi: new Date(),
      },
    });
    await kullaniciOturumlariniIptalEt(id);
    await audit(
      'sifre_sifirlandi',
      { kullaniciId: me.id, kullaniciAdi: me.kullaniciAdi, firmaId: me.firmaId },
      { hedefId: id },
    );
    res.json({ ok: true, varsayilanSifre });
  }),
);

// ── DELETE /api/kullanicilar/:id (soft delete) ──────────────────
kullanicilarRouter.delete(
  '/:id',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const me = req.authCtx!.kullanici;
    const id = paramStr(req, 'id');
    const target = await prisma.kullanici.findUnique({ where: { id } });
    if (!target) throw new HttpError(404, 'Kullanici bulunamadi.');
    if (me.rol !== 'super_admin' && target.rol === 'super_admin') {
      throw new HttpError(403, 'Süper Yöneticiyi silmek için Süper Yönetici yetkisi gereklidir.');
    }
    if (target.id === me.id) throw new HttpError(400, 'Kendi hesabinizi silemezsiniz.');
    if (me.rol !== 'super_admin' && me.rol !== 'firma_admin' && target.firmaId !== me.firmaId) {
      throw new HttpError(403, 'Bu kullaniciyi silemezsiniz.');
    }
    await prisma.kullanici.update({
      where: { id },
      data: { aktifMi: false, silmeTarihi: new Date() },
    });
    await kullaniciOturumlariniIptalEt(id);
    await audit(
      'kullanici_silindi',
      { kullaniciId: me.id, kullaniciAdi: me.kullaniciAdi, firmaId: me.firmaId },
      { hedefId: id },
    );
    res.json({ ok: true });
  }),
);
