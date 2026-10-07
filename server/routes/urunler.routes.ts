import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { requireAuth } from '../middleware/requireAuth.js';
import { asyncHandler, HttpError } from '../middleware/errorHandler.js';
import { makeCrud } from '../lib/crudFactory.js';
import { prisma } from '../lib/prisma.js';
import { canAccessFirma } from '../lib/firmaScope.js';

export const urunlerRouter: Router = Router();
const crud = makeCrud('urun');

type UrunSearchRow = {
  id: string;
  urunKod: string | null;
  urunAdi: string;
  aciklama: string | null;
  marka: string | null;
  birim: string | null;
  varsayilanFiyat: number | null;
  skor: number;
};

function resolveSearchFirmaId(req: Parameters<typeof requireAuth>[0]): string {
  const kullanici = req.authCtx!.kullanici;
  const firmaIdHeader = (req.headers['x-firma-id'] as string | undefined)?.trim() || '';

  if (firmaIdHeader) {
    if (!canAccessFirma(kullanici, firmaIdHeader)) {
      throw new HttpError(403, 'Bu firma icin urun arama yetkiniz yok.');
    }
    return firmaIdHeader;
  }

  if (kullanici.rol === 'firma_admin' && kullanici.gosterilenFirmalar.length > 0) {
    return kullanici.gosterilenFirmalar[0];
  }

  if (kullanici.firmaId) {
    return kullanici.firmaId;
  }

  throw new HttpError(400, 'Urun arama icin firma secimi gerekli.');
}

urunlerRouter.get('/search', requireAuth, asyncHandler(async (req, res) => {
  const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (rawQuery.length < 2) {
    throw new HttpError(400, 'Arama metni en az 2 karakter olmalidir.');
  }

  const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 20;
  if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
    throw new HttpError(400, 'Limit pozitif bir sayi olmalidir.');
  }
  const limit = Math.min(rawLimit, 50);
  const firmaId = resolveSearchFirmaId(req);

  try {
    const rows = await prisma.$queryRaw<UrunSearchRow[]>(Prisma.sql`
      SELECT id, "urunKod", "urunAdi", aciklama, marka, birim, "varsayilanFiyat",
             GREATEST(
               similarity(coalesce("urunKod", ''), ${rawQuery}),
               similarity(coalesce(aciklama, ''), ${rawQuery}) * 0.7,
               similarity(coalesce(marka, ''), ${rawQuery}) * 0.5
             ) AS skor
      FROM "urunler"
      WHERE "deletedAt" IS NULL
        AND "firmaId" = ${firmaId}
        AND (
          coalesce("urunKod", '') % ${rawQuery}
          OR coalesce(aciklama, '') % ${rawQuery}
          OR coalesce(marka, '') % ${rawQuery}
        )
      ORDER BY skor DESC, "urunKod" ASC
      LIMIT ${limit};
    `);

    /* NE: Arama skorunun dışarı gönderilmediğini açıkça belirt. NEDEN: Lint hatası.
       NASIL: Skoru void ile tüket. YAN ETKİ: Yanıt alanları değişmez. */
    res.json(rows.map(({ skor, ...urun }) => { void skor; return urun; }));
  } catch (error) {
    throw new HttpError(500, 'Urun arama sorgusu calistirilamadi.', error);
  }
}));

urunlerRouter.get('/', requireAuth, asyncHandler(crud.handleList));
urunlerRouter.put('/', requireAuth, asyncHandler(crud.handleBulkReplace));
urunlerRouter.put('/:id', requireAuth, asyncHandler(crud.handleUpsert));
urunlerRouter.delete('/:id', requireAuth, asyncHandler(crud.handleRemove));
