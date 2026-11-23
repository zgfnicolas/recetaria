import { createHash } from "node:crypto";
import type { Request } from "express";
import type { RateLimitConfig } from "../../middlewares/rate-limit.middleware.js";

/**
 * Mensaje genérico del `429` de `/auth`: idéntico exista o no la cuenta (anti-enumeración `RN-08`).
 */
export const AUTH_RATE_LIMIT_EXCEEDED_MESSAGE = "Demasiados intentos, intentá nuevamente más tarde";

const FIFTEEN_MINUTES_MS = 15 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;

/**
 * Login por IP (#39): 10 intentos **fallidos** cada 15 minutos; los exitosos no consumen cuota,
 * ni los `429` del limitador por cuenta (reintentar contra una cuenta bloqueada no bloquea la IP
 * ni, detrás de un NAT, a otros usuarios).
 */
export const DEFAULT_AUTH_LOGIN_IP_RATE_LIMIT: RateLimitConfig = Object.freeze({
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 10,
  identifier: "auth-login-ip",
  countOnlyFailures: true,
  ignoreRateLimitedResponses: true,
  message: AUTH_RATE_LIMIT_EXCEEDED_MESSAGE,
});

/**
 * Login por cuenta (#39): 20 intentos **fallidos** cada 15 minutos por email normalizado,
 * desde cualquier IP (frena el ataque distribuido contra una misma cuenta). Umbral mayor que el
 * de IP y ventana corta para acotar el bloqueo dirigido de la cuenta de un tercero. No emite
 * headers: no revela a terceros cuántos fallos tuvo un email ni cuándo se bloqueará.
 */
export const DEFAULT_AUTH_LOGIN_ACCOUNT_RATE_LIMIT: RateLimitConfig = Object.freeze({
  windowMs: FIFTEEN_MINUTES_MS,
  limit: 20,
  identifier: "auth-login-account",
  countOnlyFailures: true,
  exposeHeaders: false,
  message: AUTH_RATE_LIMIT_EXCEEDED_MESSAGE,
});

/** Registro por IP (#39): 5 solicitudes por hora (creación masiva de cuentas y costo de Bcrypt). */
export const DEFAULT_AUTH_REGISTER_RATE_LIMIT: RateLimitConfig = Object.freeze({
  windowMs: ONE_HOUR_MS,
  limit: 5,
  identifier: "auth-register-ip",
  message: AUTH_RATE_LIMIT_EXCEEDED_MESSAGE,
});

/** Mismo tope que `emailFieldSchema` (`VARCHAR(255)`). */
const MAX_EMAIL_LENGTH = 255;
const LOGIN_ACCOUNT_KEY_PREFIX = "login-account:";

/**
 * Clave del limitador por cuenta: `sha256` del email de `req.body` normalizado igual que
 * `emailFieldSchema` (`trim` + `toLowerCase`), para que las variantes compartan cuota y el store
 * en memoria no guarde emails en claro (`docs/compliance.md`). Corre antes de la validación Zod:
 * si el cuerpo no trae un email utilizable devuelve `undefined` y solo aplica el límite por IP.
 */
export function loginAccountRateLimitKey(req: Request): string | undefined {
  const body: unknown = req.body;
  if (typeof body !== "object" || body === null || !("email" in body)) {
    return undefined;
  }

  const { email } = body;
  if (typeof email !== "string") {
    return undefined;
  }

  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > MAX_EMAIL_LENGTH) {
    return undefined;
  }

  return `${LOGIN_ACCOUNT_KEY_PREFIX}${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}
