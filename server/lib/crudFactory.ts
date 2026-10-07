import type { Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { bumpFields, softDeleteFields } from './bump.js';
import { canAccessFirma } from './firmaScope.js';
import { deriveCtx } from './reqCtx.js';

type ModelKey = 'teklif' | 'cari' | 'urun' | 'urunSeti';

/**
 * İzin verilen alan listesi — body'den bunları whitelist eder; managed alanlar
 * (version, deletedAt, vb.) ve istenmeyen alanlar (id, firmaId — ayrı yönetilir)
 * filtrelenir.
 */
const MANAGED_FIELDS = new Set([
  'id',
  'version',
  'deviceId',
  'updatedBy',
  'lastSyncedAt',
  'deletedAt',
  'olusturmaTarihi',
  'guncellemeTarihi',
]);

function pickInputFields<T extends Record<string, unknown>>(
  body: T,
  excludeFirmaId: boolean = false,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(body || {})) {
    if (MANAGED_FIELDS.has(k)) continue;
    if (excludeFirmaId && k === 'firmaId') continue;
    out[k] = (body as Record<string, unknown>)[k];
  }
  return out;
}

export interface CrudOptions {
  /** Yeni kayıtlarda firmaId zorunluluğu. */
  firmaIdRequired?: boolean;
}

export function makeCrud(modelKey: ModelKey, _opts: CrudOptions = {}) {
  /* NE: Ayrılmış seçenek parametresini açıkça tüket. NEDEN: Lint hatası.
     NASIL: void. YAN ETKİ: CRUD davranışı ve imzası aynı kalır. */
  void _opts;
  const model = prisma[modelKey] as unknown as {
    findMany: (args: unknown) => Promise<unknown[]>;
    findUnique: (args: unknown) => Promise<{ version?: number; firmaId?: string } | null>;
    create: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
  };

  return {
    /** GET /api/<collection> — firma scope + soft-delete filter */
    async handleList(req: Request, res: Response) {
      const k = req.authCtx!.kullanici;
      const firmaIdHeader = (req.headers['x-firma-id'] as string | undefined) || '';
      const where: Prisma.JsonObject = { deletedAt: null };
      if (firmaIdHeader) {
        if (!canAccessFirma(k, firmaIdHeader)) {
          res.json([]);
          return;
        }
        where.firmaId = firmaIdHeader;
      } else if (k.rol !== 'super_admin') {
        // Header yoksa: super_admin tümü, diğerleri sadece kendi firmaları
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
        (where as Record<string, unknown>).firmaId = { in: izinli };
      }
      const rows = await model.findMany({ where });
      res.json(rows);
    },

    /** PUT /api/<collection>/:id — upsert */
    async handleUpsert(req: Request, res: Response) {
      const id = req.params.id;
      const body = req.body ?? {};
      const ctx = deriveCtx(req);
      const existing = await model.findUnique({ where: { id } });
      const data = pickInputFields(body);

      // firmaId güvenliği: body'den gelse de auth ile doğrula
      const targetFirmaId = (body.firmaId as string | undefined) || existing?.firmaId;
      if (targetFirmaId && !canAccessFirma(req.authCtx!.kullanici, targetFirmaId)) {
        res.status(403).json({ error: 'Bu firmaya yazma yetkiniz yok.' });
        return;
      }

      const sync = bumpFields(existing?.version, { deviceId: ctx.deviceId, userId: ctx.userId });
      const finalData = { ...data, ...sync };

      if (existing) {
        const updated = await model.update({ where: { id }, data: finalData });
        res.json(updated);
        return;
      }

      const created = await model.create({
        data: { id, ...finalData, deletedAt: null },
      });
      res.json(created);
    },

    /** DELETE /api/<collection>/:id — soft delete */
    async handleRemove(req: Request, res: Response) {
      const id = req.params.id;
      const existing = await model.findUnique({ where: { id } });
      if (!existing) {
        res.json({ ok: true });
        return;
      }
      if (existing.firmaId && !canAccessFirma(req.authCtx!.kullanici, existing.firmaId)) {
        res.status(403).json({ error: 'Bu kayda erisim yetkiniz yok.' });
        return;
      }
      const ctx = deriveCtx(req);
      const sync = softDeleteFields(existing.version, { deviceId: ctx.deviceId, userId: ctx.userId });
      await model.update({ where: { id }, data: sync });
      res.json({ ok: true });
    },

    /** PUT /api/<collection> — bulk replace (yalnızca cariler/urunler/urunSetleri) */
    async handleBulkReplace(req: Request, res: Response) {
      const k = req.authCtx!.kullanici;
      const list = Array.isArray(req.body) ? req.body : [];
      const ctx = deriveCtx(req);
      const firmaIdHeader = (req.headers['x-firma-id'] as string | undefined) || '';
      if (!firmaIdHeader || !canAccessFirma(k, firmaIdHeader)) {
        res.status(403).json({ error: 'firmaId scope gerekli.' });
        return;
      }

      const incomingIds = new Set<string>(list.map((r: { id: string }) => r.id));

      // Mevcut kayıtları topluca çek
      const mevcutList = (await model.findMany({
        where: { firmaId: firmaIdHeader, deletedAt: null },
      })) as Array<{ id: string; version?: number }>;
      const mevcutMap = new Map(mevcutList.map((r) => [r.id, r]));

      // Upsert döngüsü — Prisma transaction'da topluca
      const ops: Promise<unknown>[] = [];
      for (const item of list) {
        const prev = mevcutMap.get(item.id);
        const data = pickInputFields(item);
        const sync = bumpFields(prev?.version, { deviceId: ctx.deviceId, userId: ctx.userId });
        if (prev) {
          ops.push(model.update({ where: { id: item.id }, data: { ...data, ...sync } }));
        } else {
          ops.push(
            model.create({
              data: { id: item.id, firmaId: firmaIdHeader, ...data, ...sync, deletedAt: null },
            }),
          );
        }
      }
      // Soft-delete missing
      for (const old of mevcutList) {
        if (!incomingIds.has(old.id)) {
          const sync = softDeleteFields(old.version, { deviceId: ctx.deviceId, userId: ctx.userId });
          ops.push(model.update({ where: { id: old.id }, data: sync }));
        }
      }
      await prisma.$transaction(ops as Prisma.PrismaPromise<unknown>[]);
      const refreshed = await model.findMany({ where: { firmaId: firmaIdHeader, deletedAt: null } });
      res.json(refreshed);
    },
  };
}
