/**
 * dataStore.ts
 * In-memory cache of all shared data.
 *
 * Strategy (online-only mimari):
 *  - App start: fetch everything from server → populate cache. Server
 *    erişilemiyorsa hata fırlat → App.tsx ServerErrorScreen gösterir.
 *  - Reads: synchronous, from cache (no await needed in services).
 *  - Writes: update cache immediately + fire-and-forget PUT/DELETE. Network
 *    fail olursa console.error + syncEngine.setOnlineState(false) ile UI'a
 *    "Bağlı Değil" yansıt; kullanıcı manuel "Yeniden Bağlan" tetikler.
 *
 * Eski offline queue mantığı (syncEngine.enqueue, snapshot, conflict) tamamen
 * kaldırıldı — proje artık tek server + tarayıcı modelinde çalışıyor.
 */

import type { Teklif, Cari, Urun, UrunSeti } from '../types';
import type { KullaniciRol } from '../types/kullanici';
import { api, getActiveFirmaId } from './apiClient';
import type { Referans, Sayac } from './apiClient';
import { syncEngine } from './syncEngine';
import { isYonetici } from '../utils/yetkiUtils';

/** Yeni eklenen kayda (firmaId yoksa) aktif firmaId'yi inject eder.
 *  Mevcut firmaId varsa dokunulmaz — eski kayitlari koruyalim. */
function withFirmaId<T extends { firmaId?: string }>(rec: T): T {
  if (rec.firmaId) return rec;
  const firmaId = getActiveFirmaId();
  return firmaId ? { ...rec, firmaId } : rec;
}

/**
 * Defense-in-depth görünürlük filtresi — server zaten filtre uyguluyor ama
 * gelecekte init/refresh fonksiyonlarında ek bir koruma katmanı olarak
 * kullanılabilir. Şu an dataStore içinde aktif çağrılmıyor (server'a güveniyoruz)
 * ancak ileride gerekirse burada hazır.
 */
export function applyVisibilityFilter(
  teklifler: Teklif[],
  kullanici?: { id: string; rol: KullaniciRol },
): Teklif[] {
  if (!kullanici || isYonetici(kullanici.rol)) return teklifler;
  return teklifler.filter((t) => {
    const vis = t.visibility || 'team';
    return vis === 'team' || t.hazirlayanKullaniciId === kullanici.id;
  });
}

// ── Store shape ───────────────────────────────────────────────────────────────

interface Store {
  teklifler: Teklif[];
  cariler: Cari[];
  urunler: Urun[];
  urunSetleri: UrunSeti[];
  referans: Referans;
  sayac: Sayac;
}

const VARSAYILAN_REFERANS: Referans = {
  markalar: ['SMC', 'Maxtor', 'SICK', 'Danfoss', 'WINMAN'],
  birimler: ['Adet', 'Takım', 'Metre', 'Cm', 'Mm', 'Kg', 'Litre', 'Paket', 'Kutu', 'Set', 'Rulo'],
  teslimSecenekleri: ['2-3 Gün', '5-7 Gün', '10 Gün', '1-2 Hafta', '2-3 Hafta', '4-6 Hafta', 'Stok', 'Sipariş Üzerine'],
  odemeVadesiSecenekleri: ['Peşin', 'Mal mukabili', '%50 sipariş + %50 sevk', '15 Gün', '30 Gün', '45 Gün', '60 Gün', '90 Gün'],
  kdvOranlari: ['0', '1', '10', '20'],
  gecerlilikSecenekleri: ['7 Gün', '15 Gün', '1 Hafta', '2 Hafta', '1 Ay', '2 Ay', '3 Ay', '6 Ay', 'Sınırsız'],
  paraBirimleri: ['TRY', 'EUR', 'USD'],
  dovizKuruSecenekleri: ['TCMB Fatura', 'TCMB Döviz Alış', 'TCMB Döviz Satış', 'TCMB Efektif Alış', 'TCMB Efektif Satış', 'Serbest Kur'],
};

let store: Store = {
  teklifler: [],
  cariler: [],
  urunler: [],
  urunSetleri: [],
  referans: VARSAYILAN_REFERANS,
  sayac: { yil: new Date().getFullYear(), ay: new Date().getMonth() + 1, deger: 0 },
};

// ── One-time localStorage migration ──────────────────────────────────────────

const MIGRATION_FLAG = 'meba_ls_migrated';

async function migrasyonDene(): Promise<void> {
  if (localStorage.getItem(MIGRATION_FLAG)) return;

  try {
    const teklifler: Teklif[] = JSON.parse(localStorage.getItem('teklif_teklifler') ?? '[]');
    const cariler: Cari[]     = JSON.parse(localStorage.getItem('teklif_cariler')   ?? 'null') ?? [];
    const urunler: Urun[]     = JSON.parse(localStorage.getItem('teklif_urunler')   ?? 'null') ?? [];
    const sayacDeger           = parseInt(localStorage.getItem('teklif_sayac') ?? '0', 10);
    const markalar: string[]  = JSON.parse(localStorage.getItem('teklif_markalar')          ?? 'null') ?? [];
    const birimler: string[]  = JSON.parse(localStorage.getItem('teklif_birimler')           ?? 'null') ?? [];
    const teslim: string[]    = JSON.parse(localStorage.getItem('teklif_teslim_secenekleri') ?? 'null') ?? [];

    const hasData = teklifler.length > 0 || cariler.length > 1 || urunler.length > 15;
    if (!hasData) {
      localStorage.setItem(MIGRATION_FLAG, '1');
      return;
    }

    await api.migrate({
      teklifler,
      cariler,
      urunler,
      referans: {
        markalar:           markalar.length   ? markalar  : undefined,
        birimler:           birimler.length   ? birimler  : undefined,
        teslimSecenekleri:  teslim.length     ? teslim    : undefined,
      },
      sayacDeger,
    });

  } catch {
    // migration failure is non-critical
  } finally {
    localStorage.setItem(MIGRATION_FLAG, '1');
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

export async function initDataStore(
  kullanici?: { id: string; rol: string },
): Promise<void> {
  // Online-only: server erişilemezse hata fırlat → App.tsx ServerErrorScreen.
  await migrasyonDene();
  const data = await api.init(kullanici);
  store = {
    teklifler: data.teklifler,
    cariler:   data.cariler,
    urunler:   data.urunler,
    urunSetleri: data.urunSetleri ?? [],
    referans:  normalizeReferans(data.referans),
    sayac:     data.sayac ?? { yil: new Date().getFullYear(), ay: new Date().getMonth() + 1, deger: 0 },
  };
  // Init başarılı → online state set
  syncEngine.setOnlineState(true);
}

// Server'dan gelen referans yapısı tutarsız olabilir (eski flat / yeni per-firma /
// migration ortası). Client her zaman flat {markalar, birimler, teslimSecenekleri}
// bekliyor — eksik veya yanlış şekildeyse boş listelerle defansif normalize et.
function normalizeReferans(raw: unknown): Referans {
  const empty: Referans = { markalar: [], birimler: [], teslimSecenekleri: [], odemeVadesiSecenekleri: [], kdvOranlari: [], gecerlilikSecenekleri: [], paraBirimleri: [], dovizKuruSecenekleri: [] };
  if (!raw || typeof raw !== 'object') return empty;
  const r = raw as Record<string, unknown>;
  // Flat yapı (markalar dizisi varsa) → direkt kullan
  if (Array.isArray(r.markalar) || Array.isArray(r.birimler) || Array.isArray(r.teslimSecenekleri)) {
    return {
      markalar:                  Array.isArray(r.markalar)                  ? r.markalar                  as string[] : [],
      birimler:                  Array.isArray(r.birimler)                  ? r.birimler                  as string[] : [],
      teslimSecenekleri:         Array.isArray(r.teslimSecenekleri)         ? r.teslimSecenekleri         as string[] : [],
      odemeVadesiSecenekleri:    Array.isArray(r.odemeVadesiSecenekleri)    ? r.odemeVadesiSecenekleri    as string[] : [],
      kdvOranlari:               Array.isArray(r.kdvOranlari)               ? r.kdvOranlari               as string[] : [],
      gecerlilikSecenekleri:     Array.isArray(r.gecerlilikSecenekleri)     ? r.gecerlilikSecenekleri     as string[] : [],
      paraBirimleri:             Array.isArray(r.paraBirimleri)             ? r.paraBirimleri             as string[] : [],
      dovizKuruSecenekleri:      Array.isArray(r.dovizKuruSecenekleri)      ? r.dovizKuruSecenekleri      as string[] : [],
    };
  }
  // Per-firma map (eski server yeni db.json'la karşılaştığında) — herhangi bir
  // dolu firma referansını seç (sonra server restart edilince doğru firma gelecek).
  for (const v of Object.values(r)) {
    if (v && typeof v === 'object') {
      const inner = v as Record<string, unknown>;
      if (Array.isArray(inner.markalar) || Array.isArray(inner.birimler) || Array.isArray(inner.teslimSecenekleri)) {
        return {
          markalar:                  Array.isArray(inner.markalar)                  ? inner.markalar                  as string[] : [],
          birimler:                  Array.isArray(inner.birimler)                  ? inner.birimler                  as string[] : [],
          teslimSecenekleri:         Array.isArray(inner.teslimSecenekleri)         ? inner.teslimSecenekleri         as string[] : [],
          odemeVadesiSecenekleri:    Array.isArray(inner.odemeVadesiSecenekleri)    ? inner.odemeVadesiSecenekleri    as string[] : [],
          kdvOranlari:               Array.isArray(inner.kdvOranlari)               ? inner.kdvOranlari               as string[] : [],
          gecerlilikSecenekleri:     Array.isArray(inner.gecerlilikSecenekleri)     ? inner.gecerlilikSecenekleri     as string[] : [],
          paraBirimleri:             Array.isArray(inner.paraBirimleri)             ? inner.paraBirimleri             as string[] : [],
          dovizKuruSecenekleri:      Array.isArray(inner.dovizKuruSecenekleri)      ? inner.dovizKuruSecenekleri      as string[] : [],
        };
      }
    }
  }
  return empty;
}

// ── Network error handler — fire-and-forget yazımlar için ────────────────────

/**
 * Promise reddedildiğinde:
 *   - 403 (Forbidden): caller bilsin diye sessizce yut (sahiplik hatası UI'da
 *     ayrıca message ile gösterilir).
 *   - Diğer ağ hataları: console.error + syncEngine offline state.
 *
 * Yeni online-only mimaride başarısız yazımlar yeniden denenmez — kullanıcı
 * "Bağlı Değil" görür, manuel "Yeniden Bağlan" yapar, işlemi tekrar dener.
 */
function handleNetworkError(promise: Promise<unknown>, label: string): void {
  promise.catch((err: unknown) => {
    if (err && typeof err === 'object' && (err as { status?: number }).status === 403) return;
    console.error(`[dataStore] ${label} ağ hatası:`, err);
    syncEngine.setOnlineState(false, err instanceof Error ? err.message : 'Ağ hatası');
  });
}

// ── Teklif upsert tek-uçuş kilidi ────────────────────────────────────────────
// NE: Aynı teklif için aynı anda EN FAZLA BİR PUT uçuşta olur; kayıt sürerken
//     gelen yeni versiyonlar kuyruğa yazılır (sadece EN SONUNCUSU tutulur) ve
//     uçuş bitince tek seferde gönderilir.
// NEDEN: 600ms debounce'lu autosave, yükleme süresi uzun (büyük/eski görsel
//        gömülü) tekliflerde üst üste binen paralel PUT'lar üretiyordu.
//        Sunucu loglarında çökme öncesi saniyede 3-4 yarıda kesilmiş ~1.6MB
//        istek görüldü → 512MB bellek doldu → oomKilled (23 Haz'dan beri 48).
// NASIL: id-bazlı in-flight kümesi + "en son hali" pending haritası; finally
//        ile uçuş kapanınca bekleyen varsa zincirleme gönderilir.
// YAN ETKİ: Ara versiyonlar sunucuya hiç gitmez (atlanır) — zaten upsert
//        olduğu için son hali kazanır; veri kaybı yok, trafik azalır.
const teklifUpsertUcusta = new Set<string>();
const teklifUpsertBekleyen = new Map<string, Teklif>();

function teklifUpsertGonder(t: Teklif): void {
  if (teklifUpsertUcusta.has(t.id)) {
    teklifUpsertBekleyen.set(t.id, t);
    return;
  }
  teklifUpsertUcusta.add(t.id);
  const ucusBitti = () => {
    teklifUpsertUcusta.delete(t.id);
    const bekleyen = teklifUpsertBekleyen.get(t.id);
    if (bekleyen) {
      teklifUpsertBekleyen.delete(t.id);
      teklifUpsertGonder(bekleyen);
    }
  };
  handleNetworkError(api.teklifler.upsert(t).finally(ucusBitti), 'upsertTeklif');
}

// ── Public cache accessors ────────────────────────────────────────────────────

export const dataStore = {
  // ── Teklifler ──────────────────────────────────────────────────────────────

  getTeklifler:   ()            => store.teklifler,
  setTeklifler:   (v: Teklif[]) => { store.teklifler = v; },

  /** Re-fetch teklifler from server with current user's visibility filter.
   *  Kullanıcı değişince veya TeklifListesi açılınca taze veri için. */
  async refreshTeklifler(kullanici?: { id: string; rol: string }): Promise<void> {
    const liste = await api.teklifler.list(kullanici);
    store.teklifler = liste;
  },

  /** Re-fetch cariler — /api/init ile aynı kapsamdaki tam cari listesi (visibility-filter-free).
   *  TeklifListesi açılışında kart logosu/snapshot tazeliği için kullanılır.
   *  NE/NEDEN: Eskiden tam açılış verisini (tüm teklif + 46 bin ürün) çekiyordu → sunucu bellek
   *  taşması. NASIL: yalnız /api/init/cariler. YAN ETKİ: aynı cariler, çok daha hafif istek. */
  async refreshCariler(kullanici?: { id: string; rol: string }): Promise<void> {
    const data = await api.initCariler(kullanici);
    store.cariler = data.cariler;
  },
  cacheUpsertTeklif(t: Teklif): void {
    const idx = store.teklifler.findIndex((x) => x.id === t.id);
    if (idx >= 0) { store.teklifler[idx] = t; }
    else { store.teklifler.unshift(t); }
  },

  upsertTeklif(t: Teklif): void {
    const enriched = withFirmaId(t);
    const idx = store.teklifler.findIndex((x) => x.id === enriched.id);
    if (idx >= 0) { store.teklifler[idx] = enriched; }
    else { store.teklifler.unshift(enriched); }
    teklifUpsertGonder(enriched);
  },

  deleteTeklif(id: string): void {
    store.teklifler = store.teklifler.filter((x) => x.id !== id);
    handleNetworkError(api.teklifler.sil(id), 'deleteTeklif');
  },

  // ── Cariler ───────────────────────────────────────────────────────────────

  getCariler: ()                => store.cariler,
  setCariler: (v: Cari[])       => { store.cariler = v; },

  upsertCari(c: Cari): void {
    const enriched = withFirmaId(c);
    const idx = store.cariler.findIndex((x) => x.id === enriched.id);
    if (idx >= 0) { store.cariler[idx] = enriched; }
    else { store.cariler.push(enriched); }
    handleNetworkError(api.cariler.upsert(enriched), 'upsertCari');
  },

  deleteCari(id: string): void {
    store.cariler = store.cariler.filter((x) => x.id !== id);
    handleNetworkError(api.cariler.sil(id), 'deleteCari');
  },

  bulkReplaceCariler(liste: Cari[]): void {
    const enriched = liste.map(withFirmaId);
    store.cariler = enriched;
    handleNetworkError(api.cariler.bulkReplace(enriched), 'bulkReplaceCariler');
  },

  // ── Urunler ───────────────────────────────────────────────────────────────

  getUrunler: ()                => store.urunler,
  setUrunler: (v: Urun[])       => { store.urunler = v; },

  upsertUrun(u: Urun): void {
    const enriched = withFirmaId(u);
    const idx = store.urunler.findIndex((x) => x.id === enriched.id);
    if (idx >= 0) { store.urunler[idx] = enriched; }
    else { store.urunler.push(enriched); }
    handleNetworkError(api.urunler.upsert(enriched), 'upsertUrun');
  },

  deleteUrun(id: string): void {
    store.urunler = store.urunler.filter((x) => x.id !== id);
    handleNetworkError(api.urunler.sil(id), 'deleteUrun');
  },

  bulkReplaceUrunler(liste: Urun[]): void {
    const enriched = liste.map(withFirmaId);
    store.urunler = enriched;
    handleNetworkError(api.urunler.bulkReplace(enriched), 'bulkReplaceUrunler');
  },

  // ── Ürün Setleri ─────────────────────────────────────────────────────────

  getUrunSetleri: ()                => store.urunSetleri,
  setUrunSetleri: (v: UrunSeti[])   => { store.urunSetleri = v; },

  upsertUrunSeti(s: UrunSeti): void {
    const enriched = withFirmaId(s);
    const idx = store.urunSetleri.findIndex((x) => x.id === enriched.id);
    if (idx >= 0) { store.urunSetleri[idx] = enriched; }
    else { store.urunSetleri.push(enriched); }
    handleNetworkError(api.urunSetleri.upsert(enriched), 'upsertUrunSeti');
  },

  deleteUrunSeti(id: string): void {
    store.urunSetleri = store.urunSetleri.filter((x) => x.id !== id);
    handleNetworkError(api.urunSetleri.sil(id), 'deleteUrunSeti');
  },

  bulkReplaceUrunSetleri(liste: UrunSeti[]): void {
    const enriched = liste.map(withFirmaId);
    store.urunSetleri = enriched;
    handleNetworkError(api.urunSetleri.bulkReplace(enriched), 'bulkReplaceUrunSetleri');
  },

  // ── Referans ──────────────────────────────────────────────────────────────

  getReferans:    ()             => store.referans,

  setReferans(r: Referans): void {
    store.referans = r;
    handleNetworkError(api.referans.kaydet(r), 'setReferans');
  },

  // ── Sayac ─────────────────────────────────────────────────────────────────

  getSayac: () => store.sayac,

  /** Increments counter on server (atomic) and updates local cache. Returns new teklifNo. */
  async incrementSayac(): Promise<string> {
    const result = await api.sayac.increment();
    store.sayac = result;
    const yy = String(result.yil).slice(-2);
    const mm = String(result.ay ?? new Date().getMonth() + 1).padStart(2, '0');
    return `${yy}${mm}-${String(result.deger).padStart(3, '0')}`;
  },
};
