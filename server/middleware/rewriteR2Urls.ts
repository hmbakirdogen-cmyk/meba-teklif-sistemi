/**
 * rewriteR2Urls.ts
 * ──────────────────────────────────────────────────────────────────
 * Tüm JSON response'larda Cloudflare r2.dev public URL'lerini backend
 * proxy endpoint'imize (/api/storage) yeniden yazan Express middleware.
 *
 * Neden:
 *   r2.dev URL'leri production'da güvenilmez — kurumsal firewall'larda
 *   SSL_PROTOCOL_ERROR veriyor, Cloudflare rate-limit uygulayabiliyor.
 *   DB'de tarihsel olarak r2.dev URL'leri kaydedilmiş; migration script
 *   ile kalıcı temizlenebilir ama production'da hızlı çözüm için
 *   response-time rewrite kullanıyoruz.
 *
 * Akış:
 *   res.json(...) çağrısı → body'yi string'e serialize et → r2.dev host'unu
 *   "/api/storage" ile değiştir → string'i içerikle gönder. JSON parse'a
 *   gerek yok, tek serialize + replace + send.
 *
 * Performans:
 *   Tüm JSON response'larda 1 regex replace çalışır (küçük body'lerde
 *   mikrosaniye seviye). Endpoint'ler için fark edilmez.
 */

import type { Request, Response, NextFunction } from 'express';
import { r2AdresleriniDuzelt } from '../lib/jsonAkis.js';

const R2_DEV_HOST_TEST = /https?:\/\/pub-[a-f0-9]+\.r2\.dev/i;

/*
  NE: res.json'u, gövdeyi yalnız BİR kez JSON'a çevirecek şekilde sarar (r2.dev düzeltmesi dahil).
  NEDEN: Eski hâli r2.dev bulunmayan her cevapta gövdeyi iki kez JSON'a çeviriyordu (önce test için,
         sonra Express'in kendi res.json'u); büyük cevaplarda bu çift kopya 512 MB'lık sunucunun
         bellek taşmasına katkı veriyordu.
  NASIL: Tek JSON.stringify → r2.dev varsa düzeltilir ve içerik türü eskisi gibi zorla yazılır; yoksa
         Express'in yaptığı gibi içerik türü yalnız boşsa atanır → res.send. Serileştirme hatası,
         tanımsız gövde veya uygulamada özel JSON ayarı varsa eski yola (Express res.json) düşülür.
  YAN ETKİ: Gönderilen baytlar ve başlıklar eskisiyle aynıdır; yalnız bellek ve işlemci kullanımı azalır.
*/
export function rewriteR2UrlsMiddleware(_req: Request, res: Response, next: NextFunction) {
  const originalJson = res.json.bind(res);
  res.json = function (data: unknown) {
    const app = res.app;
    if (app && (app.get('json replacer') || app.get('json spaces') || app.get('json escape'))) {
      return originalJson(data);
    }
    let json: string | undefined;
    try {
      json = JSON.stringify(data);
    } catch {
      // serialize fail → orijinal davranış
      return originalJson(data);
    }
    if (json === undefined) return originalJson(data);
    if (R2_DEV_HOST_TEST.test(json)) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.send(r2AdresleriniDuzelt(json));
    }
    if (!res.get('Content-Type')) res.set('Content-Type', 'application/json');
    return res.send(json);
  };
  next();
}
