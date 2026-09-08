/**
 * DIŞ RAPOR KAPISI — salt-okuma teklif erişimi
 * ─────────────────────────────────────────────────────────────────
 * NE: Teklif Sistemi'nin dışındaki programların (ilk kullanıcı: MEBA Sales,
 *     saha satış programı) geçmiş teklifleri ve onay sonuçlarını okuyabilmesi
 *     için üç adet GET uç noktası.
 *
 * NEDEN: Mehmet abi teklif sonuçlarını telefondan takip etmek istiyor. Mevcut
 *     `GET /api/teklifler` bu iş için kullanılamaz — orada alan seçimi yok,
 *     yani `satirlar` ve `gorseller` JSON sütunları da dönüyor (bu uç noktanın
 *     bellek şişmesi geçmişi var: commit 4ce7004 "OOM cokme dongusu").
 *     Ayrıca oradaki kimlik `X-Session-Token`, yani süreli insan oturumu;
 *     program-programa konuşma için kalıcı bir anahtar gerekiyor.
 *
 * NASIL: Ayrı bir yüzey (`/api/dis`) + kendi Bearer anahtarı doğrulaması +
 *     Prisma `select` ile alan beyaz listesi. Mevcut `requireAuth` /
 *     `requireFirmaScope` zincirine hiç girmez, onlara dokunmaz.
 *
 * YAN ETKİ: YOK. Bu dosya yeni eklendi; mevcut hiçbir uç nokta, model ya da
 *     davranış değişmedi. Veritabanı şemasına dokunulmadı (migration yok).
 *     Sorun çıkarsa index.ts'teki tek `app.use('/api/dis', ...)` satırı
 *     yorum alınarak bütünüyle kapatılabilir.
 *
 * KIRMIZI ÇİZGİLER (bu dosyada korunur):
 *   1. Yalnız okuma — tek bir yazma yolu yok.
 *   2. Anahtar ortam değişkeninde (`RAPOR_API_TOKEN`), kodda değil.
 *   3. Anahtar tanımsız ya da zayıfsa uç nokta AÇILMAZ (503 döner).
 *   4. `satirlar`, `gorseller` ve tam `cariSnapshot` dışarı çıkmaz —
 *      kalem fiyatları ticari sırdır. Dışarı çıkan tek para bilgisi
 *      `genelToplam`.
 */

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { headerStr } from '../lib/params.js';
import { asyncHandler, HttpError } from '../middleware/errorHandler.js';

export const raporRouter: Router = Router();

// ─────────────────────────────────────────────────────────────────
// SABİTLER
// ─────────────────────────────────────────────────────────────────

/** Anahtarın kabul edilebilir en kısa uzunluğu. Bunun altındaki bir değer
 *  kazara/geçici konmuş sayılır ve kapı açılmaz — "uç nokta asla açık
 *  kalmasın" kuralının ikinci kilidi. */
const EN_KISA_ANAHTAR = 24;

const VARSAYILAN_LIMIT = 200;
const TAVAN_LIMIT = 1000;

/**
 * Geçerli teklif durumları.
 * KANONİK KAYNAK: src/types/teklif.ts (TeklifDurum).
 * DİKKAT: schema.prisma'daki yorum satırı ESKİDİR ('kazanildi' | 'kayip'
 * yazar) — o değerler kodda kullanılmaz. Doğru liste budur.
 */
const GECERLI_DURUMLAR = [
  'taslak',
  'hazir',
  'gonderildi',
  'onaylandi',
  'kismi_onaylandi',
  'siparis_alindi',
  'reddedildi',
  'iptal',
] as const;

type TeklifDurum = (typeof GECERLI_DURUMLAR)[number];

/**
 * Rapor gruplaması — src/pages/teklifListesiShared.ts:46-55 ile BİREBİR aynı.
 * İki program aynı sayıyı göstersin diye burada tekrar tanımlandı; ön yüz
 * kodunu sunucuya import etmek mimariyi kirletirdi.
 */
const GRUPLAR: Record<string, readonly TeklifDurum[]> = {
  kazanildi: ['onaylandi', 'kismi_onaylandi'],
  kaybedildi: ['reddedildi'],
  iptal: ['iptal'],
  bekliyor: ['taslak', 'hazir', 'gonderildi'],
};

/** Dışarı verilen alanlar — BEYAZ LİSTE. Buraya bir alan eklemek, o alanı
 *  Teklif Sistemi'nin dışına çıkarmak demektir; bilinçli karar ister. */
const DIS_ALANLAR = {
  id: true,
  teklifNo: true,
  tarih: true,
  durum: true,
  firmaId: true,
  genelToplam: true,
  paraBirimi: true,
  hazirlayanAdSoyad: true,
  sonucTarihi: true,
  kayipSebebi: true,
  rakipFirma: true,
  revizyonNo: true,
  guncellemeTarihi: true,
  // cariSnapshot yalnızca `firmaAdi` alanını çıkarmak için seçilir; ham hâli
  // ASLA yanıta konmaz (bkz. disTeklif()). Postgres JSON alanının tek bir
  // anahtarını Prisma select ile almak mümkün değil — alternatif ham SQL
  // yazmaktı, tip güvenliğini kaybetmemek için bu yol seçildi. Snapshot
  // birkaç kilobayttır; ağır olan satirlar/gorseller zaten alınmıyor.
  cariSnapshot: true,
} as const;

/** Tekil teklif detayında ek olarak dönen alanlar.
 *  Listede DÖNMEZ: 271 teklifin kalemleriyle birlikte taşınması hem ağır olur
 *  hem de gereksiz — kalemler yalnızca kullanıcı o teklifi AÇTIĞINDA gider. */
const DIS_DETAY_ALANLAR = {
  ...DIS_ALANLAR,
  satirlar: true,
  araToplam: true,
  toplamIndirim: true,
  toplamVergi: true,
  kdvOrani: true,
  odemeVadesi: true,
  gecerlilikSuresi: true,
} as const;

// ─────────────────────────────────────────────────────────────────
// KİMLİK — Bearer anahtarı
// ─────────────────────────────────────────────────────────────────

/**
 * İki metni sabit zamanda karşılaştırır.
 *
 * Her iki değer önce SHA-256'dan geçirilir; böylece uzunlukları daima 32 bayt
 * olur. Bu iki işe yarar: (a) timingSafeEqual farklı uzunlukta hata fırlatır,
 * bu önlenir; (b) anahtarın uzunluğu yanıt süresinden sızmaz.
 */
function esitMi(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/** İsteğin taşıdığı Bearer anahtarı; yoksa boş metin. */
function istekAnahtari(req: Request): string {
  const yetki = headerStr(req, 'authorization');
  if (yetki.toLowerCase().startsWith('bearer ')) return yetki.slice(7).trim();
  return '';
}

/**
 * Dış rapor kapısının kimlik doğrulaması.
 *
 * `RAPOR_API_TOKEN` tanımlı değilse ya da çok kısaysa uç nokta hiç açılmaz
 * (503) — kapının yanlışlıkla herkese açık kalması ihtimali yok.
 */
function raporAnahtariGerekli(req: Request, _res: Response, next: NextFunction): void {
  const beklenen = (process.env.RAPOR_API_TOKEN || '').trim();
  if (beklenen.length < EN_KISA_ANAHTAR) {
    // Sunucu günlüğüne tek satır: yanlış kurulumu sessizce geçmeyelim.
    console.warn(
      '[rapor] RAPOR_API_TOKEN tanimli degil veya cok kisa — /api/dis kapali (503).',
    );
    next(new HttpError(503, 'Dis rapor kapisi bu sunucuda etkin degil.'));
    return;
  }
  const gelen = istekAnahtari(req);
  if (!gelen || !esitMi(gelen, beklenen)) {
    next(new HttpError(401, 'Gecersiz veya eksik erisim anahtari.'));
    return;
  }
  next();
}

// ─────────────────────────────────────────────────────────────────
// YARDIMCILAR
// ─────────────────────────────────────────────────────────────────

/** cariSnapshot JSON'undan yalnızca müşteri adını güvenle çıkarır. */
function cariAdiCikar(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const ad = (snapshot as Record<string, unknown>).firmaAdi;
  return typeof ad === 'string' && ad.trim() ? ad : null;
}

/** cariSnapshot'tan carinin KALICI kimliğini çıkarır.
 *
 *  NEDEN: Alıcı program teklifleri firmaya göre gruplayacak. İsimle gruplamak
 *  ölçüldü ve GÜVENİLMEZ çıktı: aynı firma "MONDİ YATAK YORGAN SAN.TİC. A.Ş."
 *  ve kısa adıyla ayrı ayrı yazılabiliyor, 271 teklifin yalnızca 53'ü hedef
 *  programdaki adla birebir tutuyordu. Kalıcı kimlikle gruplama tahmine yer
 *  bırakmaz. Teklif tablosunda cariye giden bir yabancı anahtar YOK; kimlik
 *  yalnızca snapshot'ın içinde duruyor.
 */
function cariMetin(snapshot: unknown, alan: string): string | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const v = (snapshot as Record<string, unknown>)[alan];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Prisma satırını dışarı verilecek biçime çevirir — cariSnapshot burada düşer. */
function disTeklif(t: Record<string, unknown>) {
  const { cariSnapshot, ...kalan } = t;
  return {
    ...kalan,
    cariAdi: cariAdiCikar(cariSnapshot),
    cariId: cariMetin(cariSnapshot, 'id'),
    cariKod: cariMetin(cariSnapshot, 'cariKod'),
  };
}

/** Teklif kalemlerinin dışarı çıkan biçimi — ALAN ALAN seçilir.
 *
 *  NEDEN alan alan: `satirlar` veritabanında serbest JSON. Ham hâlini geçirmek,
 *  bugün bilmediğimiz (ya da yarın eklenecek) bir alanın da telefona gitmesi
 *  demek olurdu. Beyaz liste, teklifin kendisinde zaten müşteriye giden
 *  bilgiyle sınırlı.
 *
 *  `onayDurumu` bilinçli olarak VAR: kısmi onaylarda hangi kalemin kabul
 *  edildiği sahadaki en değerli bilgi — Mehmet abi'nin takip etmek istediği şey.
 */
function disSatir(s: unknown) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const r = s as Record<string, unknown>;
  const metin = (a: string) => (typeof r[a] === 'string' ? (r[a] as string) : null);
  const sayi = (a: string) => (typeof r[a] === 'number' && Number.isFinite(r[a]) ? (r[a] as number) : null);
  return {
    marka: metin('marka'),
    urunKod: metin('urunKod'),
    urunAdi: metin('urunAdi'),
    aciklama: metin('aciklama'),
    miktar: sayi('miktar'),
    birim: metin('birim'),
    birimFiyat: sayi('birimFiyat'),
    indirimOrani: sayi('indirimOrani'),
    satirToplami: sayi('satirToplami'),
    paraBirimi: metin('paraBirimi'),
    altKalem: r.setAltKalem === true,
    onayDurumu: metin('onayDurumu'),
  };
}

function disSatirlar(ham: unknown) {
  if (!Array.isArray(ham)) return [];
  return ham.map(disSatir).filter((s): s is NonNullable<typeof s> => s !== null);
}

/** Tekil sorgu değerini güvenli metne indirger (Express 5 çok-değer uyumlu). */
function sorguStr(req: Request, ad: string): string {
  const v = req.query?.[ad];
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0].trim();
  return '';
}

/**
 * `durum` süzgecini çözer.
 * Tek değer ya da virgülle ayrılmış liste kabul eder
 * (örnek: `durum=onaylandi,kismi_onaylandi` → "kazanılanlar" tek çağrıda).
 * Tanınmayan değer 400 döner — sessizce boş liste dönüp "hiç teklif yok"
 * yanılgısı yaratmasın.
 */
function durumSuzgeci(ham: string): TeklifDurum[] | undefined {
  if (!ham) return undefined;
  const istenen = ham
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const gecersiz = istenen.filter((d) => !GECERLI_DURUMLAR.includes(d as TeklifDurum));
  if (gecersiz.length > 0) {
    throw new HttpError(
      400,
      `Tanimsiz durum: ${gecersiz.join(', ')}. Gecerli degerler: ${GECERLI_DURUMLAR.join(', ')}`,
    );
  }
  return istenen as TeklifDurum[];
}

/** `guncellemeSonrasi` parametresini tarihe çevirir. */
function tarihSuzgeci(ham: string): Date | undefined {
  if (!ham) return undefined;
  const d = new Date(ham);
  if (Number.isNaN(d.getTime())) {
    throw new HttpError(400, 'guncellemeSonrasi gecerli bir ISO tarih olmali (ornek: 2026-09-01T00:00:00.000Z).');
  }
  return d;
}

/** Ortak `where` kurucusu — iki uç nokta da aynı süzgeçleri kullanır. */
function whereKur(req: Request): Record<string, unknown> {
  const where: Record<string, unknown> = { deletedAt: null };

  const firmaId = sorguStr(req, 'firmaId');
  if (firmaId) {
    if (firmaId.length > 40) throw new HttpError(400, 'firmaId cok uzun.');
    where.firmaId = firmaId;
  }

  const durumlar = durumSuzgeci(sorguStr(req, 'durum'));
  if (durumlar) where.durum = { in: durumlar };

  const sonrasi = tarihSuzgeci(sorguStr(req, 'guncellemeSonrasi'));
  if (sonrasi) {
    // `gte` bilinçli tercih: aynı milisaniyede kaydedilen iki teklifin biri
    // atlanmasın. Karşı taraf kayıtları id üzerinden birleştirdiği için
    // (INSERT OR REPLACE) son kaydın bir kez tekrar gelmesi zararsız.
    where.guncellemeTarihi = { gte: sonrasi };
  }

  return where;
}

// ─────────────────────────────────────────────────────────────────
// GET /api/dis/teklifler — sayfalı, beyaz listeli teklif listesi
// ─────────────────────────────────────────────────────────────────
raporRouter.get(
  '/teklifler',
  raporAnahtariGerekli,
  asyncHandler(async (req, res) => {
    const where = whereKur(req);

    const hamLimit = Number.parseInt(sorguStr(req, 'limit'), 10);
    const limit =
      Number.isFinite(hamLimit) && hamLimit > 0
        ? Math.min(hamLimit, TAVAN_LIMIT)
        : VARSAYILAN_LIMIT;

    const imlec = sorguStr(req, 'imlec');

    const satirlar = await prisma.teklif.findMany({
      where,
      select: DIS_ALANLAR,
      // guncellemeTarihi artan → artımlı çekim doğru çalışır.
      // id ikincil sıra: aynı zaman damgalı kayıtlarda sıra kararlı kalsın,
      // yoksa imleçli sayfalama kayıt atlayabilir.
      orderBy: [{ guncellemeTarihi: 'asc' }, { id: 'asc' }],
      take: limit,
      ...(imlec ? { cursor: { id: imlec }, skip: 1 } : {}),
    });

    const sonrakiImlec =
      satirlar.length === limit ? satirlar[satirlar.length - 1]?.id ?? null : null;

    res.json({
      teklifler: satirlar.map((t) => disTeklif(t as unknown as Record<string, unknown>)),
      adet: satirlar.length,
      limit,
      sonrakiImlec,
      cekilmeZamani: new Date().toISOString(),
    });
  }),
);

// ─────────────────────────────────────────────────────────────────
// GET /api/dis/cariler — sayfalı, beyaz listeli CARİ (firma) listesi
//
// NEDEN VAR: MEBA Sales'te müşteri ile buradaki firma elle eşleştiriliyor.
//   Eşleştirme listesi bugüne kadar YALNIZ tekliflerden türetiliyordu, yani
//   "teklif verilmiş firmalar" listesiydi. Mehmet abi sahada bunu gördü:
//   "tüm firmaları göremiyorum ki ben orda, mesela HİS TEKSTİL" — o firmanın
//   burada carisi var ama henüz teklifi yok, bu yüzden listede hiç çıkmıyordu.
//   Bu uç nokta cari listesinin kendisini veriyor; eşleştirme artık teklifi
//   olmayan firmayı da bulabiliyor.
//
// KIRMIZI ÇİZGİLER (dosyanın başındakiler burada da geçerli):
//   · Yalnız okuma. · Beyaz liste: yalnız id, cariKod, firmaAdi, sehir.
//   · Telefon, e-posta, adres, vergi no, notlar, kişiler DIŞARI ÇIKMAZ —
//     eşleştirme için gereken tek şey kimlik ve ad; gerisi kişisel veridir.
//   · Silinmiş cari (deletedAt) dönmez.
// ─────────────────────────────────────────────────────────────────
raporRouter.get(
  '/cariler',
  raporAnahtariGerekli,
  asyncHandler(async (req, res) => {
    const where: Record<string, unknown> = { deletedAt: null };

    const firmaId = sorguStr(req, 'firmaId');
    if (firmaId) {
      if (firmaId.length > 40) throw new HttpError(400, 'firmaId cok uzun.');
      where.firmaId = firmaId;
    }

    const sonrasi = tarihSuzgeci(sorguStr(req, 'guncellemeSonrasi'));
    if (sonrasi) where.guncellemeTarihi = { gte: sonrasi };

    const hamLimit = Number.parseInt(sorguStr(req, 'limit'), 10);
    const limit =
      Number.isFinite(hamLimit) && hamLimit > 0
        ? Math.min(hamLimit, TAVAN_LIMIT)
        : VARSAYILAN_LIMIT;

    const imlec = sorguStr(req, 'imlec');

    const satirlar = await prisma.cari.findMany({
      where,
      // Beyaz liste: eşleştirme için gereken en az bilgi.
      select: { id: true, cariKod: true, firmaAdi: true, sehir: true, guncellemeTarihi: true },
      orderBy: [{ guncellemeTarihi: 'asc' }, { id: 'asc' }],
      take: limit,
      ...(imlec ? { cursor: { id: imlec }, skip: 1 } : {}),
    });

    const sonrakiImlec =
      satirlar.length === limit ? satirlar[satirlar.length - 1]?.id ?? null : null;

    res.json({
      cariler: satirlar,
      adet: satirlar.length,
      limit,
      sonrakiImlec,
      cekilmeZamani: new Date().toISOString(),
    });
  }),
);

// ─────────────────────────────────────────────────────────────────
// GET /api/dis/teklif-ozet — durum bazlı adet + tutar
// ─────────────────────────────────────────────────────────────────
raporRouter.get(
  '/teklif-ozet',
  raporAnahtariGerekli,
  asyncHandler(async (req, res) => {
    const where = whereKur(req);

    // Para birimi kırılımı ŞART: bu sistemde teklifler TRY/EUR/USD karışık
    // olabiliyor. Hepsini tek sayıda toplamak (100 EUR + 100 TRY = 200)
    // gerçek bir hata olurdu — toplamlar para birimi başına ayrı verilir.
    const ham = await prisma.teklif.groupBy({
      by: ['durum', 'paraBirimi'],
      where,
      _count: { _all: true },
      _sum: { genelToplam: true },
    });

    type Kirilim = { paraBirimi: string; adet: number; toplam: number };
    const durumHaritasi = new Map<string, { adet: number; kirilim: Kirilim[] }>();

    for (const r of ham) {
      const durum = r.durum ?? 'belirtilmemis';
      const pb = r.paraBirimi ?? 'belirtilmemis';
      const adet = r._count._all;
      const toplam = r._sum.genelToplam ?? 0;

      const kayit = durumHaritasi.get(durum) ?? { adet: 0, kirilim: [] };
      kayit.adet += adet;
      kayit.kirilim.push({ paraBirimi: pb, adet, toplam });
      durumHaritasi.set(durum, kayit);
    }

    const durumlar = [...durumHaritasi.entries()].map(([durum, v]) => ({
      durum,
      adet: v.adet,
      paraBirimine_gore: v.kirilim.sort((a, b) => b.toplam - a.toplam),
    }));

    // Telefon panosu tek çağrıda dolsun diye grup toplamları da hazır verilir
    // (Kazanıldı / Kaybedildi / İptal / Bekliyor).
    const gruplar: Record<string, { adet: number; paraBirimine_gore: Kirilim[] }> = {};
    for (const [grupAdi, dahilDurumlar] of Object.entries(GRUPLAR)) {
      const birlesik = new Map<string, Kirilim>();
      let adet = 0;
      for (const d of dahilDurumlar) {
        const kayit = durumHaritasi.get(d);
        if (!kayit) continue;
        adet += kayit.adet;
        for (const k of kayit.kirilim) {
          const mevcut = birlesik.get(k.paraBirimi) ?? {
            paraBirimi: k.paraBirimi,
            adet: 0,
            toplam: 0,
          };
          mevcut.adet += k.adet;
          mevcut.toplam += k.toplam;
          birlesik.set(k.paraBirimi, mevcut);
        }
      }
      gruplar[grupAdi] = {
        adet,
        paraBirimine_gore: [...birlesik.values()].sort((a, b) => b.toplam - a.toplam),
      };
    }

    res.json({
      firmaId: sorguStr(req, 'firmaId') || null,
      genelAdet: [...durumHaritasi.values()].reduce((t, v) => t + v.adet, 0),
      durumlar: durumlar.sort((a, b) => b.adet - a.adet),
      gruplar,
      hesaplamaZamani: new Date().toISOString(),
    });
  }),
);

// ─────────────────────────────────────────────────────────────────
// GET /api/dis/teklif/:id — tek teklifin detayı (kalemler dahil)
// ─────────────────────────────────────────────────────────────────
raporRouter.get(
  '/teklif/:id',
  raporAnahtariGerekli,
  asyncHandler(async (req, res) => {
    const id = String(req.params.id ?? '').trim();
    if (!id) throw new HttpError(400, 'Teklif kimligi gerekli.');

    const t = await prisma.teklif.findFirst({
      where: { id, deletedAt: null },
      select: DIS_DETAY_ALANLAR,
    });
    if (!t) throw new HttpError(404, 'Teklif bulunamadi.');

    const ham = t as unknown as Record<string, unknown>;
    const { satirlar: hamSatirlar, ...kalan } = ham;

    res.json({
      teklif: {
        ...disTeklif(kalan),
        satirlar: disSatirlar(hamSatirlar),
      },
      cekilmeZamani: new Date().toISOString(),
    });
  }),
);
