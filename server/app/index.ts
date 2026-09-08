import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import cron from 'node-cron';

import { prisma } from '../lib/prisma.js';
import { expiredOturumlariSil } from '../lib/sessions.js';
import { auditPrune } from '../lib/audit.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { rewriteR2UrlsMiddleware } from '../middleware/rewriteR2Urls.js';

import { authRouter } from '../routes/auth.routes.js';
import { firmalarRouter } from '../routes/firmalar.routes.js';
import { kullanicilarRouter } from '../routes/kullanicilar.routes.js';
import { tekliflerRouter } from '../routes/teklifler.routes.js';
import { carilerRouter } from '../routes/cariler.routes.js';
import { urunlerRouter } from '../routes/urunler.routes.js';
import { urunSetleriRouter } from '../routes/urunSetleri.routes.js';
import { referansRouter } from '../routes/referans.routes.js';
import { sayacRouter } from '../routes/sayac.routes.js';
import { bildirimlerRouter } from '../routes/bildirimler.routes.js';
import { geribildirimRouter } from '../routes/geribildirim.routes.js';
import { initRouter } from '../routes/init.routes.js';
import { emailRouter } from '../routes/email.routes.js';
import { storageRouter } from '../routes/storage.routes.js';
import { kurRouter } from '../routes/kur.routes.js';
import { raporRouter } from '../routes/rapor.routes.js';
import { mountStaticServe } from './staticServe.js';

const app = express();
const PORT = Number(process.env.PORT || 3001);

// ── CORS ───────────────────────────────────────────────────────
// Production'da same-origin olduğu için CORS önemli değil; dev'de Vite
// proxy `/api` → `localhost:3001`'e yönlendirir. Yine de defansif olarak
// permissive bir kural koyuyoruz; gerekirse ALLOWED_ORIGIN env'i ile daraltılır.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.length === 0) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('CORS engelli origin: ' + origin));
    },
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Device-Id', 'X-User-Id', 'X-User-Role', 'X-Session-Token', 'X-Firma-Id'],
  }),
);

app.use(compression());

// Body parser — base64 PDF'ler için yüksek limit
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ extended: true, limit: '60mb' }));

// Tüm JSON response'larda r2.dev URL'lerini /api/storage'a rewrite et.
// DB'de tarihsel r2.dev URL'leri var; production'da hızlı çözüm için
// response-time rewrite (migration script'i istenirse ayrıca çalıştırılır).
app.use(rewriteR2UrlsMiddleware);

// ── Health check ───────────────────────────────────────────────
// Render Postgres latency yüksekse health check timeout'ta sıkışmasın diye
// 3 saniye Promise.race ile fast-fail. prismaOk=false → Render restart kararı.
app.get('/api/health', async (_req, res) => {
  const prismaOk = await Promise.race([
    prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
  ]);
  res.json({
    ok: true,
    service: 'group-companies-teklif-api',
    timestamp: new Date().toISOString(),
    uptimeSec: Math.floor(process.uptime()),
    prismaOk,
  });
});

// ── API routes ─────────────────────────────────────────────────
app.use('/api/dis', raporRouter); // salt-okuma dis rapor kapisi (kendi Bearer anahtari; requireAuth zincirine girmez)
app.use('/api/auth', authRouter);
app.use('/api', firmalarRouter); // firmalar/firma/firma/:id/personel/firma/:id/logo
app.use('/api/kullanicilar', kullanicilarRouter);
app.use('/api/teklifler', tekliflerRouter);
app.use('/api/cariler', carilerRouter);
app.use('/api/urunler', urunlerRouter);
app.use('/api/urunSetleri', urunSetleriRouter);
app.use('/api/referans', referansRouter);
app.use('/api/sayac', sayacRouter);
app.use('/api/bildirimler', bildirimlerRouter);
app.use('/api/geribildirim', geribildirimRouter);
app.use('/api/init', initRouter);
app.use('/api/teklif', emailRouter); // /api/teklif/eposta-gonder
app.use('/api/storage', storageRouter); // R2 nesneleri için backend proxy
app.use('/api/kur', kurRouter); // TCMB günlük döviz kurları (USD/EUR)

// 404 for unmatched /api/*
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Frontend static + SPA fallback ─────────────────────────────
mountStaticServe(app);

// ── Error handler ──────────────────────────────────────────────
app.use(errorHandler);

// ── Cron jobs ──────────────────────────────────────────────────
// Saatte bir süresi geçmiş oturumları temizle
cron.schedule('0 * * * *', async () => {
  try {
    const removed = await expiredOturumlariSil();
    if (removed > 0) console.log(`[cron] ${removed} expired session removed`);
  } catch (err) {
    console.warn('[cron] session prune failed:', err);
  }
});

// Günde bir audit log'u trim et
cron.schedule('5 3 * * *', async () => {
  try {
    await auditPrune();
  } catch (err) {
    console.warn('[cron] audit prune failed:', err);
  }
});

// ── Server start ───────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log('');
  console.log('  Grup Şirketleri Teklif — API');
  console.log(`  http://localhost:${PORT}`);
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  env: ${process.env.NODE_ENV || 'development'}`);
  console.log('');
});

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  console.log(`\n[${signal}] kapanış başlatıldı...`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
