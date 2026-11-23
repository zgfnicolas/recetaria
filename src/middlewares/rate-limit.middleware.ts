import type { RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { AppError } from "../shared/errors/app-error.js";

/** Configuración de una ventana fija de rate limit por IP. */
export type RateLimitConfig = Readonly<{
  windowMs: number;
  limit: number;
  /** Nombre de la política en los headers `RateLimit`/`RateLimit-Policy` (draft-8). */
  identifier?: string | undefined;
}>;

/**
 * Límite por defecto del catálogo público `GET /api/v1/recipes` (#36, OWASP API4):
 * 120 solicitudes por minuto por IP (~2 req/s sostenidas).
 */
export const DEFAULT_PUBLIC_READ_RATE_LIMIT: RateLimitConfig = Object.freeze({
  windowMs: 60_000,
  limit: 120,
  identifier: "recipes-public-read",
});

export const RATE_LIMIT_EXCEEDED_MESSAGE = "Demasiadas solicitudes, intentá nuevamente más tarde";

/** Headers de rate limit que los clientes de navegador necesitan leer (CORS `exposedHeaders`). */
export const RATE_LIMIT_EXPOSED_HEADERS = ["RateLimit", "RateLimit-Policy", "Retry-After"] as const;

function assertValidRateLimitConfig(config: RateLimitConfig): void {
  if (!Number.isInteger(config.windowMs) || config.windowMs < 1) {
    throw new RangeError(`windowMs inválido para rate limit: ${String(config.windowMs)}`);
  }
  if (!Number.isInteger(config.limit) || config.limit < 1) {
    throw new RangeError(`limit inválido para rate limit: ${String(config.limit)}`);
  }
}

/**
 * Construye un rate limit por IP (ventana fija, store en memoria de `express-rate-limit`).
 * - Headers estándar `RateLimit`/`RateLimit-Policy` (draft-8) y `Retry-After` al exceder; sin `X-RateLimit-*`.
 * - Al exceder delega `AppError(429)` a `next()` para que el manejador global responda en JSend.
 * - IPv6 se agrupa por subred `/56` (default de la librería) para evitar evasión rotando direcciones.
 *
 * El store en memoria es por proceso: válido para una réplica (MVP). Con varias réplicas
 * o detrás de un proxy se requiere store compartido y `trust proxy` (ver `docs/sad.md`).
 */
export function createRateLimitMiddleware(
  config: RateLimitConfig = DEFAULT_PUBLIC_READ_RATE_LIMIT,
): RequestHandler {
  assertValidRateLimitConfig(config);

  return rateLimit({
    windowMs: config.windowMs,
    limit: config.limit,
    identifier: config.identifier ?? `${String(config.limit)}-per-${String(config.windowMs)}ms`,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new AppError(429, RATE_LIMIT_EXCEEDED_MESSAGE));
    },
  });
}
