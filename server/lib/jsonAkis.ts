/*
  NE: Büyük JSON cevaplarını tek parça dize kurmadan, dilim dilim gönderen yardımcılar ve
      r2.dev adres düzelticisi.
  NEDEN: /api/init tüm teklif, cari ve ürün verisini (46 bin ürün) tek bir JSON dizesi hâlinde
         kuruyordu; r2.dev adres düzeltmesi ve gönderim bu dizeyi 2-3 kez kopyalıyordu. 512 MB'lık
         Render sunucusu 12-17 Eylül 2026 arasında 26 kez bellek taşmasıyla kapandı, kullanıcılar
         her seferinde 502 gördü.
  NASIL: Kayıtlar tek tek JSON'a çevrilir, r2.dev adresi kayıt başına düzeltilir, küçük parçalar
         ~64 KB'lık dilimlerde birleştirilip akışla (pipeline) gönderilir. Ağ yavaşsa akış
         kendiliğinden bekler; istemci koparsa üretim durur; üretim yarıda hata verirse bağlantı
         kesilir, böylece yarım bir JSON asla başarılı cevap gibi görünmez.
  YAN ETKİ: Gönderilen JSON baytları res.json ile birebir aynıdır; yalnız ETag başlığı üretilmez
            (tarayıcı bu cevabı her seferinde 200 olarak alır).
*/
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';

const R2_DEV_HOST_RE = /https?:\/\/pub-[a-f0-9]+\.r2\.dev/gi;
const R2_IZI = /\.r2\.dev/i;

/** JSON metnindeki r2.dev adreslerini /api/storage vekiline çevirir; eşleşme yoksa aynı dizeyi döndürür. */
export function r2AdresleriniDuzelt(json: string): string {
  return R2_IZI.test(json) ? json.replace(R2_DEV_HOST_RE, '/api/storage') : json;
}

/** Tek değeri res.json ile aynı kuralla JSON'a çevirir ve r2.dev adreslerini düzeltir. */
export function kayitJson(deger: unknown): string {
  const json = JSON.stringify(deger);
  return json === undefined ? 'null' : r2AdresleriniDuzelt(json);
}

/** Küçük metin parçalarını yaklaşık `boy` karakterlik dilimlerde birleştirir. */
async function* dilimle(parcalar: AsyncIterable<string>, boy: number): AsyncGenerator<string> {
  let tampon: string[] = [];
  let uzunluk = 0;
  for await (const parca of parcalar) {
    tampon.push(parca);
    uzunluk += parca.length;
    if (uzunluk >= boy) {
      yield tampon.join('');
      tampon = [];
      uzunluk = 0;
    }
  }
  if (tampon.length > 0) yield tampon.join('');
}

/** Bağlantı istemci tarafından kapatıldıysa true (akışın erken bitmesi olağan durumdur). */
export function istemciKoptuMu(hata: unknown): boolean {
  const kod = (hata as { code?: string } | null)?.code;
  return kod === 'ERR_STREAM_PREMATURE_CLOSE' || kod === 'ECONNRESET' || kod === 'EPIPE';
}

/** JSON parçalarını tek bir 200 cevabı olarak akışla gönderir; başlıklar ilk dilimle gider. */
export async function jsonAkisiGonder(
  res: Response,
  parcalar: AsyncIterable<string>,
  dilimBoyu = 64 * 1024,
): Promise<void> {
  res.status(200);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // highWaterMark 1: ağ yavaşken bellekte en fazla bir iki dilim bekler (istek başına bellek sabit kalır).
  await pipeline(Readable.from(dilimle(parcalar, dilimBoyu), { highWaterMark: 1 }), res);
}
