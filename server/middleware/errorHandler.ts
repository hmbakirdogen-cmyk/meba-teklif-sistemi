import type { Request, Response, NextFunction } from 'express';

export class HttpError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Express 5 async error handler — son middleware olarak mount edilir. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  /* NE: next parametresini koru. NEDEN: Express hata işleyicisini dört argümanla tanır.
     NASIL: void ile kullanılmadığını belirt. YAN ETKİ: Hata akışı değişmez. */
  void _next;
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details ?? undefined });
    return;
  }
  console.error('[API Error]', err);
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : 'Beklenmeyen sunucu hatasi.';
  res.status(500).json({ error: message });
}

/** Sync veya async handler'ları sarar, error handler'a aktarır.
 *  Express 5 zaten async function'ların reject'lerini yakalar; bu sarmal ek
 *  kolaylık için. */
export function asyncHandler<R extends Request = Request>(
  fn: (req: R, res: Response, next: NextFunction) => unknown | Promise<unknown>,
) {
  return (req: R, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
