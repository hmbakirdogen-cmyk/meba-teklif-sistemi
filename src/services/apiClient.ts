/**
 * apiClient.ts
 * Thin fetch wrapper for the Grup Şirketleri backend (server/server.cjs on port 3001).
 * Uses window.location.hostname so it works for both localhost dev and LAN IPs.
 *
 * Tüm istekler X-Device-Id, X-Session-Token ve X-Firma-Id header'ları ile gider
 * (multi-tenant + auth için). 8 saniyelik timeout ile network hata durumlarında
 * UI'nın takılmasını engeller.
 */

import type { Teklif, Cari, Urun, UrunSeti, Kullanici, Firma, Bildirim } from '../types';
import { APP_CONFIG } from '../config';
import { authStorage } from './authStorage';

const BASE = APP_CONFIG.API_BASE;
/** Default network timeout — kısa endpoint'ler için (login, kayıt, get vb.). */
const TIMEOUT_MS_DEFAULT = 8000;
/** Uzun endpoint'ler için — bulk replace (1500+ cari) ve sync push/pull/full
 *  LAN'da 8sn'i kolayca aşabilir. /sync/* ve bulkReplace bunu kullanır. */
const TIMEOUT_MS_LONG = 30000;

// ─── Auth storage adapter ──────────────────────────────────────────────
// Tüm token/user/firma erişimi src/services/authStorage.ts üzerinden olur.
// Bu dosyadaki public API (getSessionToken/setSessionToken vs.) geriye dönük
// uyumluluk için tutulur ama altta authStorage'a delege eder. Yeni kod
// doğrudan authStorage'ı tercih etmeli.
//
// "Beni Hatırla" semantiği: kullanıcı checkbox'ı authStorage.save() çağrılırken
// `remember` parametresi olarak iletilir. ŞİFRE HİÇBİR YERDE SAKLANMAZ.

export function getSessionToken(): string | null {
  return authStorage.getToken();
}
export function setSessionToken(token: string | null): void {
  // Geriye dönük uyum: yalnız token'ı silen kullanım (logout) için clearAuth.
  // Token set işlemi normalde authStorage.save() üzerinden yapılır
  // (KullaniciContext.loginYap içinde); bu setter yalnızca temizleme amaçlı.
  if (!token) authStorage.clearAuth();
  // null olmayan setToken çağrısı bu yeni mimaride beklenmez — save() kullan.
}

export function getActiveFirmaId(): string | null {
  return authStorage.getActiveFirmaId();
}
/** FirmaContext senkronizasyonu icin custom event adi (ayni tab icinde polling yerine). */
export const ACTIVE_FIRMA_CHANGE_EVENT = 'gc-active-firma-change';

export function setActiveFirmaId(firmaId: string | null): void {
  authStorage.setActiveFirmaId(firmaId);
  if (typeof window === 'undefined') return;
  // Ayni tab icinde FirmaContext'i hemen senkronize et (storage event diger
  // tab'lere gider, ayni tab'a gelmez). Polling 1 sn'lik gecikmeyi siler.
  window.dispatchEvent(new CustomEvent(ACTIVE_FIRMA_CHANGE_EVENT, {
    detail: { firmaId },
  }));
}

export function getStoredKullanici(): Kullanici | null {
  return authStorage.getUser();
}
export function setStoredKullanici(kullanici: Kullanici | null): void {
  // Geriye dönük uyum: profil foto / isim güncelleme — mevcut storage'a yaz.
  // Logout çağrısı (null) için clearAuth kullan.
  if (kullanici) authStorage.updateUser(kullanici);
  else authStorage.clearAuth();
}

function getDeviceId(): string {
  return authStorage.getDeviceId();
}

function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { 'X-Device-Id': getDeviceId(), ...extra };
  const k = getStoredKullanici();
  if (k) {
    h['X-User-Id'] = k.id;
    h['X-User-Role'] = k.rol;
  }
  const token = getSessionToken();
  if (token) h['X-Session-Token'] = token;
  const firmaId = getActiveFirmaId();
  if (firmaId) h['X-Firma-Id'] = firmaId;
  return h;
}

function withTimeout(signal?: AbortSignal, timeoutMs: number = TIMEOUT_MS_DEFAULT): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort());
  }
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

// ── Generic helpers ───────────────────────────────────────────────────────────

/**
 * Runtime'da 401 alındığında KullaniciContext'i bilgilendirmek için custom
 * event. Boot doğrulaması (/auth/me) ve login'in kendisi (/auth/login) için
 * tetiklenmez — bunların kendi 401 mantıkları var. Aynı anda gelen birden
 * fazla 401'in çoklu logout / mesaj kuyruğu oluşturmaması için 5sn'lik
 * dedupe penceresi var.
 */
export const SESSION_EXPIRED_EVENT = 'gc-session-expired';
let sessionExpiredDispatched = false;
function maybeDispatchSessionExpired(label: string): void {
  if (typeof window === 'undefined') return;
  // Auth endpoint'lerinin kendi 401 davranışı var — dışarıda tut.
  if (label.includes('/auth/login') || label.includes('/auth/logout') || label.includes('/auth/me')) return;
  if (sessionExpiredDispatched) return;
  sessionExpiredDispatched = true;
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
  setTimeout(() => { sessionExpiredDispatched = false; }, 5000);
}

/** Yardimci: response'u json'a cevirir; hata durumunda body'deki error mesajini
 *  ekleyerek throw eder. */
async function parseOrThrow<T>(res: Response, label: string): Promise<T> {
  const ct = res.headers.get('content-type') || '';
  let body: unknown = null;
  if (ct.includes('application/json')) {
    try { body = await res.json(); } catch { /* ignore */ }
  }
  if (!res.ok) {
    if (res.status === 401) {
      maybeDispatchSessionExpired(label);
    }
    const errMsg = (body && typeof body === 'object' && 'error' in (body as Record<string, unknown>))
      ? String((body as Record<string, unknown>).error)
      : `${label} → ${res.status}`;
    const err = new Error(errMsg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (body as T);
}

async function get<T>(path: string, timeoutMs?: number, signal?: AbortSignal): Promise<T> {
  const { signal: finalSignal, clear } = withTimeout(signal, timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { headers: buildHeaders(), signal: finalSignal });
    return parseOrThrow<T>(res, `GET ${path}`);
  } finally {
    clear();
  }
}

async function patch<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
  const { signal, clear } = withTimeout(undefined, timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'PATCH',
      headers: buildHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal,
    });
    return parseOrThrow<T>(res, `PATCH ${path}`);
  } finally {
    clear();
  }
}

async function put<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
  const { signal, clear } = withTimeout(undefined, timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'PUT',
      headers: buildHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal,
    });
    return parseOrThrow<T>(res, `PUT ${path}`);
  } finally {
    clear();
  }
}

async function del(path: string, timeoutMs?: number): Promise<void> {
  const { signal, clear } = withTimeout(undefined, timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: buildHeaders(), signal });
    if (!res.ok) {
      await parseOrThrow<void>(res, `DELETE ${path}`);
    }
  } finally {
    clear();
  }
}

async function post<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
  const { signal, clear } = withTimeout(undefined, timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: buildHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal,
    });
    return parseOrThrow<T>(res, `POST ${path}`);
  } finally {
    clear();
  }
}

// ── Geri Bildirim type ────────────────────────────────────────────────────────

export type GeriBildirimTur = 'hata' | 'oneri' | 'mesaj';

export interface GeriBildirim {
  id: string;
  gonderen: { id: string; adSoyad: string };
  tarih: string;
  sayfa: string;
  tur: GeriBildirimTur;
  mesaj: string;
  okundu: boolean;
  cevap: string | null;
  cevapTarihi?: string | null;
}

// ── Referans type ─────────────────────────────────────────────────────────────

export interface Referans {
  markalar: string[];
  birimler: string[];
  teslimSecenekleri: string[];
  odemeVadesiSecenekleri: string[];
  kdvOranlari: string[];
  gecerlilikSecenekleri: string[];
  paraBirimleri: string[];
  dovizKuruSecenekleri: string[];
}

export interface Sayac {
  yil: number;
  ay: number;
  deger: number;
}

export interface InitData {
  teklifler: Teklif[];
  cariler: Cari[];
  urunler: Urun[];
  urunSetleri?: UrunSeti[];
  referans: Referans;
  sayac: Sayac | null;
  firmalar?: Firma[];
}

// ── User-aware query string helper ────────────────────────────────────────────

/** Yetki query string'i (?userId=X&rol=Y) — backend visibility filter için. */
function userQuery(kullanici?: { id: string; rol: string }): string {
  if (!kullanici) return '';
  const params = new URLSearchParams({ userId: kullanici.id, rol: kullanici.rol });
  return `?${params.toString()}`;
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

export const api = {
  /** Fetch all data at once (used on app startup) — visibility filter applied */
  init: (kullanici?: { id: string; rol: string }) =>
    get<InitData>(`/init${userQuery(kullanici)}`),

  // NE: Yalnız cari listesi — /api/init ile aynı kapsam ve sıra.
  // NEDEN: Liste sayfaları carileri tazelemek için tam açılış verisini (46 bin ürün dahil) çekiyordu;
  //        sunucu 512 MB sınırında bu yüzden defalarca bellek taşmasıyla kapandı.
  // NASIL: GET /api/init/cariler → { cariler }.
  // YAN ETKİ: Ağ trafiği ve bekleme süresi belirgin azalır; gelen cariler aynıdır.
  initCariler: (kullanici?: { id: string; rol: string }) =>
    get<Pick<InitData, 'cariler'>>(`/init/cariler${userQuery(kullanici)}`),

  teklifler: {
    /** Re-fetch teklifler list with visibility filter (used when user changes
     *  or list page wants fresh data). */
    list:   (kullanici?: { id: string; rol: string }) =>
      get<Teklif[]>(`/teklifler${userQuery(kullanici)}`),
    // NE: Teklif kaydı LONG timeout kullanır (30s). NEDEN: Görsel gömülü eski
    // teklifler ~1.6MB olabiliyor; ofis upload hızında 8s'ye sığmayınca istek
    // yarıda kesiliyor, autosave yenisini başlatıyor ve sunucuda yarım gövde
    // fırtınası OOM'a katkı yapıyordu. 30s gerçek yavaş hatlara yetiyor.
    upsert:    (t: Teklif)                => put<Teklif>(`/teklifler/${t.id}`, t, TIMEOUT_MS_LONG),
    sil:       (id: string)              => del(`/teklifler/${id}`),
    pdfYukle:  (id: string, pdfBase64: string, dosyaAdi: string) =>
      post<{ ok: boolean; pdfUrl: string; teklif: Teklif }>(`/teklifler/${id}/pdf-yukle`, { pdfBase64, dosyaAdi }),
    /** Belge üstü görseli R2'ye yükler → { url: '/api/storage/…' }.
     *  Görsel teklif JSON'una gömülmez (OOM kök sebebiydi) — sadece URL saklanır. */
    gorselYukle: (gorselBase64: string) =>
      post<{ url: string }>(`/teklifler/gorsel-yukle`, { gorselBase64 }, TIMEOUT_MS_LONG),
  },

  cariler: {
    upsert:      (c: Cari)              => put<Cari>(`/cariler/${c.id}`, c),
    sil:         (id: string)           => del(`/cariler/${id}`),
    // Bulk replace 1500+ kayıt LAN'da 8sn'i aşar — long timeout.
    bulkReplace: (liste: Cari[])        => put<Cari[]>('/cariler', liste, TIMEOUT_MS_LONG),
    uploadLogo:  (id: string, fotoBase64: string) =>
      post<{ logoUrl: string; cari: Cari }>(`/cariler/${id}/logo`, { fotoBase64 }),
    silLogo:     (id: string)           => del(`/cariler/${id}/logo`),
  },

  urunler: {
    upsert:      (u: Urun)              => put<Urun>(`/urunler/${u.id}`, u),
    sil:         (id: string)           => del(`/urunler/${id}`),
    bulkReplace: (liste: Urun[])        => put<Urun[]>('/urunler', liste, TIMEOUT_MS_LONG),
    search:      (q: string, limit = 20, signal?: AbortSignal) =>
      get<Urun[]>(`/urunler/search?q=${encodeURIComponent(q)}&limit=${limit}`, undefined, signal),
  },

  urunSetleri: {
    list:        ()                      => get<UrunSeti[]>('/urunSetleri'),
    upsert:      (s: UrunSeti)           => put<UrunSeti>(`/urunSetleri/${s.id}`, s),
    sil:         (id: string)            => del(`/urunSetleri/${id}`),
    bulkReplace: (liste: UrunSeti[])     => put<UrunSeti[]>('/urunSetleri', liste, TIMEOUT_MS_LONG),
  },

  referans: {
    getir:  ()                          => get<Referans>('/referans'),
    kaydet: (r: Referans)               => put<Referans>('/referans', r),
  },

  sayac: {
    /** Backward compat: header'daki X-Firma-Id'ye gore artirir. */
    increment: ()                       => post<Sayac>('/sayac/increment', {}),
    /** Yeni: explicit firmaId ile. */
    incrementFor: (firmaId: string)     => post<Sayac & { firmaId: string }>(`/sayac/${firmaId}/increment`, {}),
  },

  // ── Teklif e-posta gönderim (in-app Outlook benzeri modal'dan) ──────────
  teklifEposta: {
    /** Modal'dan gelen verilerle teklif PDF'i mail eki olarak gönderir +
     *  başarılı SMTP send sonrası IMAP APPEND ile "Gönderilmiş Öğeler"
     *  klasörüne kopya yazılır (Outlook/365 / Yandex / Zoho için otomatik;
     *  Gmail için Gmail kendi yazar; custom SMTP için skip). */
    gonder: (payload: {
      teklifId: string;
      to: string | string[];
      cc?: string[];
      bcc?: string[];
      subject?: string;
      bodyHtml?: string;
      bodyText?: string;
      logoBase64?: string;
      logoContentType?: string;
      /** Bayilik markaları — her birinin CID + base64 + contentType. Backend
       *  body içindeki cid:partner-X referanslarını eşler. */
      partnerLogos?: Array<{ cid: string; base64: string; contentType: string }>;
      pdfBase64: string;
    }) =>
      post<{
        ok: boolean;
        messageId?: string;
        fileName?: string;
        subject?: string;
        sentSyncOk?: boolean;
        sentSyncError?: string | null;
        sentMailbox?: string | null;
        error?: string;
      }>('/teklif/eposta-gonder', payload, TIMEOUT_MS_LONG),
  },

  // ── Geri Bildirim (kullanıcı → süper admin mesaj kanalı) ──────────────────
  geriBildirimler: {
    list:    ()                                                                  => get<GeriBildirim[]>('/geribildirim'),
    create:  (data: { mesaj: string; tur: GeriBildirimTur; sayfa: string })      => post<GeriBildirim>('/geribildirim', data),
    update:  (id: string, p: { okundu?: boolean; cevap?: string })               => patch<GeriBildirim>(`/geribildirim/${id}`, p),
    sil:     (id: string)                                                        => del(`/geribildirim/${id}`),
  },

  // ── Bildirimler (atama / teklif olayları → her kullanıcı kendi listesi) ──
  bildirimler: {
    list:           ()                                  => get<Bildirim[]>('/bildirimler'),
    okundu:         (id: string)                        => patch<Bildirim>(`/bildirimler/${id}`, { okundu: true }),
    tumunuOkunduYap: ()                                 => post<{ ok: boolean; degisen: number }>('/bildirimler/toplu-okundu', {}),
  },

  // ── Auth ────────────────────────────────────────────────────────────────────
  auth: {
    login: (kullaniciAdi: string, sifre: string, secilenFirmaId?: string | null, beniHatirla = false) =>
      post<{ token: string; expiresAt: string; kullanici: Kullanici; firma: Firma | null }>(
        '/auth/login',
        { kullaniciAdi, sifre, secilenFirmaId: secilenFirmaId ?? null, beniHatirla },
      ),
    logout: ()                                   => post<{ ok: boolean }>('/auth/logout', {}),
    me:     ()                                   => get<{ kullanici: Kullanici; firma: Firma | null }>('/auth/me'),
    changePassword: (mevcutSifre: string, yeniSifre: string) =>
      post<{ ok: boolean; mustChangePassword: boolean }>('/auth/change-password', { mevcutSifre, yeniSifre }),
    uploadPhoto: (fotoBase64: string) =>
      post<{ profilFotoUrl: string; kullanici: Kullanici }>('/auth/upload-photo', { fotoBase64 }),
    /** Admin: başka bir kullanıcının profil fotosunu günceller (yüz odaklı
     *  toplu işlem için). super_admin → herkes, firma_admin → kendi firması. */
    uploadPhotoForUser: (userId: string, fotoBase64: string) =>
      post<{ profilFotoUrl: string; kullanici: Kullanici }>(
        `/auth/admin/upload-photo-for/${userId}`,
        { fotoBase64 },
      ),

    // ── SMTP (kullanıcının kendi e-posta hesabından gönderim) ─────────
    smtpAyarlar: () =>
      get<{
        smtpHost: string | null;
        smtpPort: number | null;
        smtpSecure: boolean | null;
        smtpUser: string | null;
        smtpFromName: string | null;
        smtpFromAddress: string | null;
        hasPassword: boolean;
        presets: Record<string, { host: string; port: number; secure: boolean; label: string }>;
      }>('/auth/smtp-ayarlar'),
    smtpAyarlariGuncelle: (payload: {
      smtpHost?: string;
      smtpPort?: number;
      smtpSecure?: boolean;
      smtpUser?: string;
      smtpFromName?: string;
      smtpFromAddress?: string;
      smtpPassword?: string;
      clearPassword?: boolean;
    }) =>
      patch<{
        ok: boolean;
        smtpHost: string | null;
        smtpPort: number | null;
        smtpSecure: boolean | null;
        smtpUser: string | null;
        smtpFromName: string | null;
        smtpFromAddress: string | null;
        hasPassword: boolean;
      }>('/auth/smtp-ayarlar', payload),
    smtpTest: (payload: { smtpHost: string; smtpPort: number; smtpSecure: boolean; smtpUser: string; smtpPassword: string }) =>
      post<{ ok: true } | { ok: false; error: string }>('/auth/smtp-test', payload),
    smtpTestMail: () =>
      post<{ ok: boolean; to?: string; messageId?: string; error?: string }>('/auth/smtp-test-mail', {}),

    // ── Admin: bir başka kullanıcının SMTP'sini kur ─────────────────
    smtpAyarlarForUser: (userId: string) =>
      get<{
        userId: string;
        adSoyad: string;
        kullaniciAdi: string;
        smtpHost: string | null;
        smtpPort: number | null;
        smtpSecure: boolean | null;
        smtpUser: string | null;
        smtpFromName: string | null;
        smtpFromAddress: string | null;
        hasPassword: boolean;
        presets: Record<string, { host: string; port: number; secure: boolean; label: string }>;
      }>(`/auth/admin/smtp-ayarlar/${userId}`),
    smtpAyarlariGuncelleForUser: (userId: string, payload: {
      smtpHost?: string;
      smtpPort?: number;
      smtpSecure?: boolean;
      smtpUser?: string;
      smtpFromName?: string;
      smtpFromAddress?: string;
      smtpPassword?: string;
      clearPassword?: boolean;
    }) =>
      patch<{
        ok: boolean;
        userId: string;
        smtpHost: string | null;
        smtpPort: number | null;
        smtpSecure: boolean | null;
        smtpUser: string | null;
        smtpFromName: string | null;
        smtpFromAddress: string | null;
        hasPassword: boolean;
      }>(`/auth/admin/smtp-ayarlar/${userId}`, payload),
    smtpTestMailForUser: (userId: string) =>
      post<{ ok: boolean; to?: string; messageId?: string; error?: string }>(`/auth/admin/smtp-test-mail/${userId}`, {}),
  },

  // ── Firmalar ────────────────────────────────────────────────────────────────
  firmalar: {
    /** Public — login ekranindaki splash icin token gerektirmez. */
    list:   ()                          => get<Firma[]>('/firmalar'),
    detay:  (id: string)                => get<Firma>(`/firma/${id}`),
    update: (id: string, patchBody: Partial<Firma>) => patch<Firma>(`/firma/${id}`, patchBody),
    /**
     * Public — login ekraninda firma secildikten sonra o firmanin
     * personelini kart olarak gostermek icin. Sadece minimal alanlar:
     * { id, kullaniciAdi, adSoyad, unvan, rol, firmaId, profilFotoUrl, initials }
     */
    personel: (firmaId: string) =>
      get<Array<{
        id: string;
        kullaniciAdi: string;
        adSoyad: string;
        unvan: string;
        rol: string;
        firmaId: string | null;
        profilFotoUrl: string | null;
        initials: string;
        telefon: string | null;
        dahili: string | null;
      }>>(`/firma/${firmaId}/personel`),
  },

  // ── Kullanicilar ────────────────────────────────────────────────────────────
  kullanicilar: {
    list:    ()                                                   => get<Kullanici[]>('/kullanicilar'),
    create:  (payload: { kullaniciAdi: string; adSoyad: string; unvan?: string; rol?: string; firmaId?: string; telefon?: string; dahili?: string }) =>
      post<{ kullanici: Kullanici; varsayilanSifre: string }>('/kullanicilar', payload),
    update:  (id: string, patchBody: Partial<Kullanici>)          => patch<Kullanici>(`/kullanicilar/${id}`, patchBody),
    sifirla: (id: string)                                         => post<{ ok: boolean; varsayilanSifre: string }>(`/kullanicilar/${id}/sifre-sifirla`, {}),
    sil:     (id: string)                                         => del(`/kullanicilar/${id}`),
  },

  /** One-time localStorage → server migration */
  migrate: (payload: {
    teklifler?: Teklif[];
    cariler?: Cari[];
    urunler?: Urun[];
    referans?: Partial<Referans>;
    sayacDeger?: number;
  }) => post<{ migrated: boolean; reason?: string }>('/migrate', payload),

  // ── SYNC ─────────────────────────────────────────────────────────────────
  /** Network/server health probe (LAN-spesifik). Timeout: 4 saniye. */
  async health(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(`${BASE}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  },

  // Sync mimarisi (offline queue/conflict/push/pull) tamamen kaldırıldı —
  // proje artık tek server + tarayıcı modelinde çalışıyor. Yazımlar dataStore
  // üzerinden direkt PUT/DELETE; bağlantı durumu syncEngine + api.health ile.
};
