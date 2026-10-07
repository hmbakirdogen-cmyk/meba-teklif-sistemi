import { Router } from 'express';
/* NE: Prisma kayıt tipini kullan. NEDEN: any yerine açık tip.
   NASIL: Yalnız tip importu. YAN ETKİ: Çalışma zamanı değişmez. */
import type { Prisma } from '@prisma/client';
import { paramStr } from '../lib/params.js';
import { prisma } from '../lib/prisma.js';
import { canAccessFirma, isYonetici } from '../lib/firmaScope.js';
import { bumpFields, softDeleteFields } from '../lib/bump.js';
import { deriveCtx } from '../lib/reqCtx.js';
import { shapeTeklif, shapeTeklifList } from '../lib/shape.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { asyncHandler, HttpError } from '../middleware/errorHandler.js';
import { uploadFile, deleteFile, decodeDataUrl, mimeToExt, r2Configured } from '../lib/storage.js';
import { randomUUID } from 'node:crypto';

export const tekliflerRouter: Router = Router();

const MANAGED = new Set([
  'id',
  'version',
  'deviceId',
  'updatedBy',
  'lastSyncedAt',
  'deletedAt',
  'olusturmaTarihi',
  'guncellemeTarihi',
]);

function pickTeklifInput(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(body)) {
    if (MANAGED.has(k)) continue;
    // 'cari' eski format — cariSnapshot'a map'le
    if (k === 'cari') {
      out.cariSnapshot = body[k];
      continue;
    }
    out[k] = body[k];
  }
  return out;
}

// ── GET /api/teklifler — visibility filter ──────────────────────
tekliflerRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const k = req.authCtx!.kullanici;
    const firmaIdHeader = (req.headers['x-firma-id'] as string | undefined) || '';
    const where: Record<string, unknown> = { deletedAt: null };
    if (firmaIdHeader) {
      if (!canAccessFirma(k, firmaIdHeader)) {
        res.json([]);
        return;
      }
      where.firmaId = firmaIdHeader;
    } else if (k.rol !== 'super_admin') {
      const izinli: string[] = [];
      if (k.rol === 'firma_admin' && k.gosterilenFirmalar.length > 0) {
        izinli.push(...k.gosterilenFirmalar);
      } else if (k.firmaId) {
        izinli.push(k.firmaId);
      }
      if (izinli.length === 0) {
        res.json([]);
        return;
      }
      where.firmaId = { in: izinli };
    }
    const all = await prisma.teklif.findMany({
      where,
      orderBy: { olusturmaTarihi: 'desc' },
    });
    if (isYonetici(k.rol)) {
      res.json(shapeTeklifList(all));
      return;
    }
    const filtered = all.filter((t) => {
      const vis = t.visibility ?? 'team';
      return vis === 'team' || t.hazirlayanKullaniciId === k.id;
    });
    res.json(shapeTeklifList(filtered));
  }),
);

// ── PUT /api/teklifler/:id — upsert + atama bildirimi ───────────
tekliflerRouter.put(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = paramStr(req, 'id');
    const me = req.authCtx!.kullanici;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ctx = deriveCtx(req);

    const existing = await prisma.teklif.findUnique({ where: { id } });
    const targetFirmaId = (body.firmaId as string | undefined) || existing?.firmaId;
    if (targetFirmaId && !canAccessFirma(me, targetFirmaId)) {
      throw new HttpError(403, 'Bu firmaya yazma yetkiniz yok.');
    }

    // Sahiplik kontrolü — personel başkasının teklifini düzenleyemez
    const adminLike = isYonetici(me.rol);
    if (!adminLike && existing) {
      if (existing.hazirlayanKullaniciId && existing.hazirlayanKullaniciId !== me.id) {
        throw new HttpError(403, 'Bu teklifi düzenleme yetkiniz yok.');
      }
    }
    if (!adminLike && !existing && !body.hazirlayanKullaniciId) {
      body.hazirlayanKullaniciId = me.id;
    }

    const oncekiIlgili = existing?.ilgiliKisiId ?? null;
    const data = pickTeklifInput(body);
    const sync = bumpFields(existing?.version, { deviceId: ctx.deviceId, userId: ctx.userId });

    // Race condition fix: findUnique + create arasinda baska istek ayni id ile
    // yarisabilir (kullanici hizli edit yapinca client ayni id ile birden cok
    // upsert tetikliyor). Prisma.upsert atomic — tek query'de varsa update
    // yoksa create, unique constraint hatasi olusmaz.
    let final;
    if (existing) {
      final = await prisma.teklif.update({ where: { id }, data: { ...data, ...sync } });
    } else {
      try {
        final = await prisma.teklif.create({
          data: { id, ...(data as Record<string, unknown>), ...sync, deletedAt: null } as Prisma.TeklifUncheckedCreateInput,
        });
      /* NE: Bilinmeyen hatanın kodunu güvenli daralt. NEDEN: any lint hatası.
         NASIL: Nesne ve code alanını kontrol et. YAN ETKİ: P2002 yeniden deneme korunur. */
      } catch (err: unknown) {
        // P2002 = unique constraint — baska istek bizden once create etti
        if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002') {
          final = await prisma.teklif.update({ where: { id }, data: { ...data, ...sync } });
        } else {
          throw err;
        }
      }
    }

    // Atama bildirimi: ilgiliKisi yeni atandıysa veya değiştiyse
    const yeniIlgili = final.ilgiliKisiId ?? null;
    const hazirlayan = final.hazirlayanKullaniciId ?? null;
    if (yeniIlgili && yeniIlgili !== oncekiIlgili && yeniIlgili !== hazirlayan) {
      const kaynak = await prisma.kullanici.findUnique({ where: { id: me.id } });
      const cariAdi =
        (final.cariSnapshot && typeof final.cariSnapshot === 'object' && 'firmaAdi' in final.cariSnapshot
          ? String((final.cariSnapshot as { firmaAdi?: unknown }).firmaAdi ?? '')
          : '') || '';
      await prisma.bildirim.create({
        data: {
          id: 'b-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          hedefKullaniciId: yeniIlgili,
          kaynakKullaniciId: me.id,
          kaynakKullaniciAdSoyad: kaynak?.adSoyad ?? '',
          teklifId: final.id,
          teklifNo: final.teklifNo ?? '',
          cariAdi,
          tur: 'ilgili_atandi',
          okundu: false,
          firmaId: final.firmaId,
        },
      });
    }

    res.json(shapeTeklif(final));
  }),
);

// ── POST /api/teklifler/:id/pdf-yukle — R2 arşiv ───────────────
tekliflerRouter.post(
  '/:id/pdf-yukle',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!r2Configured) throw new HttpError(503, 'R2 depolama yapılandırılmamış.');
    const id = paramStr(req, 'id');
    const me = req.authCtx!.kullanici;
    const existing = await prisma.teklif.findUnique({ where: { id } });
    if (!existing) throw new HttpError(404, 'Teklif bulunamadı.');
    if (existing.firmaId && !canAccessFirma(me, existing.firmaId)) {
      throw new HttpError(403, 'Bu teklife erişim yetkiniz yok.');
    }

    const body = req.body ?? {};
    const pdfBase64 = String(body.pdfBase64 || '');
    const dosyaAdi = String(body.dosyaAdi || `${id}.pdf`).replace(/[^a-zA-Z0-9._\- ]/g, '_');
    if (!pdfBase64) throw new HttpError(400, 'pdfBase64 zorunlu.');

    const buffer = Buffer.from(pdfBase64, 'base64');
    if (buffer.length === 0) throw new HttpError(400, 'PDF verisi geçersiz.');

    // Eski PDF varsa sil
    if (existing.pdfUrl) {
      const oldKey = existing.pdfUrl.replace(/^https?:\/\/[^/]+\//, '').split('?')[0];
      deleteFile(oldKey).catch(() => {});
    }

    const firmaId = existing.firmaId || 'ortak';
    const key = `teklifler/${firmaId}/${id}/${dosyaAdi}`;
    const { url } = await uploadFile(key, buffer, 'application/pdf', {
      contentDisposition: `inline; filename="${dosyaAdi}"`,
      cacheControl: 'no-cache',
    });

    const ctx = deriveCtx(req);
    const sync = bumpFields(existing.version, { deviceId: ctx.deviceId, userId: ctx.userId });
    const updated = await prisma.teklif.update({
      where: { id },
      data: { pdfUrl: url, pdfDosyaAdi: dosyaAdi, pdfOlusturmaTarihi: new Date(), ...sync },
    });

    res.json({ ok: true, pdfUrl: url, teklif: shapeTeklif(updated) });
  }),
);

// ── POST /api/teklifler/gorsel-yukle — belge üstü görsel R2 upload ──
// NE: A4 belgeye eklenen serbest görseli R2'ye yükler, aynı-origin proxy
//     URL'i (/api/storage/<key>) döner.
// NEDEN: Görseller eskiden teklif JSON'una base64 gömülüyordu → tek teklif
//        ~1.6MB'a şişiyor, 600ms'lik otomatik kayıt her değişiklikte bu
//        gövdeyi yeniden yüklüyor ve sunucu 512MB limitinde OOM ile
//        çöküyordu (Render events: 23 Haz'dan beri 48 oomKilled; loglar
//        çökme öncesi saniyede 3-4 yarıda kesilmiş 1.6MB istek gösteriyor).
// NASIL: dataURL decode → boyut guard'ı → `teklif-gorselleri/<uuid>.<ext>`
//        R2 key'i → relative /api/storage URL (rewriteR2Urls middleware'in
//        cari logolarında PDF dahil kanıtlanmış kalıbı).
// YAN ETKİ: R2 yapılandırılmamışsa 503 → istemci eski gömme davranışına
//        düşer (local dev R2'siz çalışmaya devam eder). Teklif id İSTEMEZ —
//        görsel, teklif DB'ye ilk kez kaydedilmeden önce de eklenebilir.
const MAX_TEKLIF_GORSEL_BYTES = 4 * 1024 * 1024;
tekliflerRouter.post(
  '/gorsel-yukle',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!r2Configured) throw new HttpError(503, 'R2 depolama yapılandırılmamış.');
    const gorselBase64 = String((req.body ?? {}).gorselBase64 || '');
    if (!gorselBase64) throw new HttpError(400, 'gorselBase64 zorunlu.');

    const { mime, buffer } = decodeDataUrl(gorselBase64);
    if (buffer.length === 0) throw new HttpError(400, 'Görsel verisi geçersiz.');
    if (!mime.startsWith('image/')) throw new HttpError(400, 'Sadece görsel dosyaları yüklenebilir.');
    if (buffer.length > MAX_TEKLIF_GORSEL_BYTES) {
      throw new HttpError(
        400,
        `Görsel çok büyük (${Math.round(buffer.length / 1024)} KB). Maks ${Math.round(MAX_TEKLIF_GORSEL_BYTES / 1024)} KB.`,
      );
    }

    const key = `teklif-gorselleri/${randomUUID()}.${mimeToExt(mime)}`;
    await uploadFile(key, buffer, mime);
    res.json({ url: `/api/storage/${key}` });
  }),
);

// ── DELETE /api/teklifler/:id — soft delete ─────────────────────
tekliflerRouter.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = paramStr(req, 'id');
    const me = req.authCtx!.kullanici;
    const existing = await prisma.teklif.findUnique({ where: { id } });
    if (!existing) {
      res.json({ ok: true });
      return;
    }
    if (existing.firmaId && !canAccessFirma(me, existing.firmaId)) {
      throw new HttpError(403, 'Bu teklife erisim yetkiniz yok.');
    }
    if (!isYonetici(me.rol) && existing.hazirlayanKullaniciId && existing.hazirlayanKullaniciId !== me.id) {
      throw new HttpError(403, 'Bu teklifi silme yetkiniz yok.');
    }
    const ctx = deriveCtx(req);
    const sync = softDeleteFields(existing.version, { deviceId: ctx.deviceId, userId: ctx.userId });
    await prisma.teklif.update({ where: { id }, data: sync });
    res.json({ ok: true });
  }),
);
