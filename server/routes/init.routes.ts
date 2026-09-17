import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { canAccessFirma, isYonetici } from '../lib/firmaScope.js';
import { shapeTeklif } from '../lib/shape.js';
import { istemciKoptuMu, jsonAkisiGonder, kayitJson } from '../lib/jsonAkis.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

export const initRouter: Router = Router();

type IstekKullanicisi = NonNullable<Request['authCtx']>['kullanici'];

// Parti boyları: teklif satırı görsel/satır bilgisiyle 1,6 MB'a çıkabildiği için küçük tutulur.
const TEKLIF_PARTISI = 100;
const KAYIT_PARTISI = 2000;

const REFERANS_DEFAULTS = {
  markalar: [] as string[],
  birimler: [] as string[],
  teslimSecenekleri: [] as string[],
  odemeVadesiSecenekleri: [] as string[],
  kdvOranlari: [] as string[],
  gecerlilikSecenekleri: [] as string[],
  paraBirimleri: [] as string[],
  dovizKuruSecenekleri: [] as string[],
};

/*
  NE: İstek sahibinin görebileceği kayıtların ortak sorgu koşulunu üretir (firma kapsamı).
  NEDEN: Aynı kural hem tam açılış verisinde hem yalnız-cari tazelemesinde birebir aynı olmalı.
  NASIL: Eski /api/init mantığı aynen taşındı: firma başlığı varsa o firma (erişim yoksa null);
         başlık yoksa süper yönetici her şeyi, firma yöneticisi gösterilen firmaları, personel kendi
         firmasını görür.
  YAN ETKİ: Yok; null dönmesi "boş cevap ver" demektir.
*/
function kapsamBelirle(k: IstekKullanicisi, firmaId: string | null): Record<string, unknown> | null {
  const baseWhere: Record<string, unknown> = { deletedAt: null };
  if (firmaId) {
    if (!canAccessFirma(k, firmaId)) return null;
    baseWhere.firmaId = firmaId;
  } else if (k.rol !== 'super_admin') {
    const izinli: string[] = [];
    if (k.rol === 'firma_admin' && k.gosterilenFirmalar.length > 0) {
      izinli.push(...k.gosterilenFirmalar);
    } else if (k.firmaId) {
      izinli.push(k.firmaId);
    }
    if (izinli.length === 0) return null;
    baseWhere.firmaId = { in: izinli };
  }
  return baseWhere;
}

function firmaBasligi(req: Request): string | null {
  return String(req.headers['x-firma-id'] || '') || null;
}

/*
  NE: Sırası önceden belirlenmiş kimlik listesini, sırayı bozmadan küçük partiler hâlinde okuyan üreteç.
  NEDEN: 46 bin ürünü tek sorguda almak, sorgu motorunda ve JavaScript tarafında aynı anda yüzlerce
         MB bellek tutuyordu (ölçüm: tek açılışta +291 MB).
  NASIL: Çağıran, kimlikleri istenen sırayla hafif bir sorguyla alır; burada kimlikler partiler hâlinde
         birincil anahtar üzerinden okunur ve her parti o sıraya göre dizilir. Parti sorgusu kapsam
         koşulunu yeniden uygular; arada silinen kayıt atlanır.
  YAN ETKİ: Veritabanına istek sayısı artar (parti başına bir hızlı birincil anahtar sorgusu); bellek
            tepe noktası parti boyutuyla sınırlı kalır.
*/
async function* siraliPartiler<T extends { id: string }>(
  kimlikler: string[],
  partiyiGetir: (kimlikler: string[]) => Promise<T[]>,
  partiBoyu: number,
): AsyncGenerator<T> {
  for (let i = 0; i < kimlikler.length; i += partiBoyu) {
    const parti = kimlikler.slice(i, i + partiBoyu);
    const harita = new Map((await partiyiGetir(parti)).map((s) => [s.id, s]));
    for (const id of parti) {
      const satir = harita.get(id);
      if (satir) yield satir;
    }
  }
}

/*
  NE: Açılış verisini (teklifler, cariler, ürünler, ürün setleri, referans, sayaç, firmalar) bellek
      dostu biçimde gönderir.
  NEDEN: Eski hâli yedi sorguyu aynı anda çalıştırıp tüm sonucu tek JSON dizesi olarak kuruyordu;
         46 bin ürünlük veri 512 MB'lık sunucuyu 12-17 Eylül 2026 arasında 26 kez bellek taşmasıyla
         düşürdü. Teklif listesi, analiz ve malzeme hareketleri sayfaları da bu isteği her açılışta
         yeniden çağırıyordu.
  NASIL: Küçük sorgular ve teklif kimlikleri başlıklar gitmeden alınır (hata olursa her zamanki 500
         döner). Sonra teklifler, cariler ve ürünler sırayla, küçük partiler hâlinde okunur; her kayıt
         JSON'a çevrilip akışla gönderilir. Alan adları, alan sırası, kayıt sırası ve r2.dev adres
         düzeltmesi eski cevapla aynıdır (ölçüm: aynı sırayla bayt bayt aynı çıktı).
  YAN ETKİ: Cevapta ETag yok. Akış başladıktan sonra bir sorgu hata verirse bağlantı kesilir
            (istemci yine hata alır, yarım veri kullanılmaz). Aynı tarihli teklifler, aynı adlı cariler
            ve ürünler artık kendi aralarında kimliğe göre sabit sırada (önceden veritabanına bağlıydı).
*/
async function acilisVerisiniGonder(
  res: Response,
  k: IstekKullanicisi,
  firmaId: string | null,
  where: Record<string, unknown>,
): Promise<void> {
  const [refRow, sayac, firmalar, urunSetleri, teklifSirasi] = await Promise.all([
    firmaId ? prisma.referans.findUnique({ where: { firmaId } }) : null,
    firmaId ? prisma.sayac.findUnique({ where: { firmaId } }) : null,
    prisma.firma.findMany({ orderBy: { id: 'asc' } }),
    prisma.urunSeti.findMany({ where }),
    prisma.teklif.findMany({
      where,
      orderBy: [{ olusturmaTarihi: 'desc' }, { id: 'asc' }],
      select: { id: true, visibility: true, hazirlayanKullaniciId: true },
    }),
  ]);

  // Visibility filter (admin değilse 'team' + kendi teklifler)
  const teklifKimlikleri = (
    isYonetici(k.rol)
      ? teklifSirasi
      : teklifSirasi.filter((t) => (t.visibility ?? 'team') === 'team' || t.hazirlayanKullaniciId === k.id)
  ).map((t) => t.id);

  const referans = refRow
    ? {
        markalar: refRow.markalar,
        birimler: refRow.birimler,
        teslimSecenekleri: refRow.teslimSecenekleri,
        odemeVadesiSecenekleri: refRow.odemeVadesiSecenekleri,
        kdvOranlari: refRow.kdvOranlari,
        gecerlilikSecenekleri: refRow.gecerlilikSecenekleri,
        paraBirimleri: refRow.paraBirimleri,
        dovizKuruSecenekleri: refRow.dovizKuruSecenekleri,
      }
    : REFERANS_DEFAULTS;
  const sayacCevabi = sayac ? { yil: sayac.yil, ay: sayac.ay, deger: sayac.deger } : null;

  async function* parcalar(): AsyncGenerator<string> {
    yield '{"teklifler":[';
    let ilk = true;
    const teklifPartileri = siraliPartiler(
      teklifKimlikleri,
      (kimlikler) => prisma.teklif.findMany({ where: { AND: [where, { id: { in: kimlikler } }] } }),
      TEKLIF_PARTISI,
    );
    for await (const t of teklifPartileri) {
      yield (ilk ? '' : ',') + kayitJson(shapeTeklif(t));
      ilk = false;
    }

    yield '],"cariler":[';
    const cariSirasi = await prisma.cari.findMany({
      where,
      orderBy: [{ firmaAdi: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    ilk = true;
    const cariPartileri = siraliPartiler(
      cariSirasi.map((c) => c.id),
      (kimlikler) => prisma.cari.findMany({ where: { AND: [where, { id: { in: kimlikler } }] } }),
      KAYIT_PARTISI,
    );
    for await (const c of cariPartileri) {
      yield (ilk ? '' : ',') + kayitJson(c);
      ilk = false;
    }

    yield '],"urunler":[';
    const urunSirasi = await prisma.urun.findMany({
      where,
      orderBy: [{ urunAdi: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    ilk = true;
    const urunPartileri = siraliPartiler(
      urunSirasi.map((u) => u.id),
      (kimlikler) => prisma.urun.findMany({ where: { AND: [where, { id: { in: kimlikler } }] } }),
      KAYIT_PARTISI,
    );
    for await (const u of urunPartileri) {
      yield (ilk ? '' : ',') + kayitJson(u);
      ilk = false;
    }

    yield '],"urunSetleri":[';
    ilk = true;
    for (const s of urunSetleri) {
      yield (ilk ? '' : ',') + kayitJson(s);
      ilk = false;
    }
    yield `],"referans":${kayitJson(referans)},"sayac":${kayitJson(sayacCevabi)},"firmalar":${kayitJson(firmalar)}}`;
  }

  try {
    await jsonAkisiGonder(res, parcalar());
  } catch (hata) {
    if (!res.headersSent) throw hata;
    if (!istemciKoptuMu(hata)) console.error('[init] akış yarıda kesildi:', hata);
  }
}

// ── GET /api/init — bulk pull, frontend boot'ta çağırır ─────────
initRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const k = req.authCtx!.kullanici;
    const firmaId = firmaBasligi(req);
    const where = kapsamBelirle(k, firmaId);
    if (!where) {
      res.json({ teklifler: [], cariler: [], urunler: [], urunSetleri: [], referans: REFERANS_DEFAULTS, sayac: null });
      return;
    }
    await acilisVerisiniGonder(res, k, firmaId, where);
  }),
);

/*
  NE: GET /api/init/cariler — yalnız cari listesini, açılış verisindekiyle aynı kapsam ve sırayla döndürür.
  NEDEN: Teklif listesi, analiz ve malzeme hareketleri sayfaları yalnız carileri tazelemek için tam
         açılış verisini (46 bin ürün dahil) çağırıyordu; bellek taşmalarının en sık tetikleyicisi buydu.
  NASIL: kapsamBelirle + aynı sorgu (firmaAdi artan); cevap { cariler } biçiminde.
  YAN ETKİ: Eski tarayıcı sekmeleri /api/init'i kullanmaya devam edebilir; ikisi de aynı carileri verir.
*/
initRouter.get(
  '/cariler',
  requireAuth,
  asyncHandler(async (req, res) => {
    const where = kapsamBelirle(req.authCtx!.kullanici, firmaBasligi(req));
    if (!where) {
      res.json({ cariler: [] });
      return;
    }
    const cariler = await prisma.cari.findMany({ where, orderBy: { firmaAdi: 'asc' } });
    res.json({ cariler });
  }),
);

/** Yalnız ölçüm/doğrulama betikleri için: yetki katmanı olmadan çekirdeği çağırmaya yarar. */
export const initCekirdegi = { kapsamBelirle, acilisVerisiniGonder };
