/**
 * Regla única de vigencia de los JWT (#52): formato compatible con `ms` (librería que usa
 * `jsonwebtoken`) y un tope máximo. Módulo puro, sin `dotenv` ni efectos, compartido por la
 * validación de arranque (`src/config/env.ts`) y por la firma (`src/modules/auth/jwt.ts`).
 */

/** Unidades válidas (en segundos o superiores) compatibles con jsonwebtoken (`ms`). */
export type JwtDurationUnit = "s" | "m" | "h" | "d" | "w" | "y";

/** Expresión de expiración JWT compatible con `ms.StringValue`. */
export type JwtExpiresIn = `${number}${JwtDurationUnit}`;

/** Formato: entero positivo de hasta 6 dígitos con unidad explícita (sin cambios desde #14). */
const JWT_EXPIRES_IN_PATTERN = /^([1-9]\d{0,5})(s|m|h|d|w|y)$/;

/** Segundos por unidad con la semántica de `ms` (`1y = 365,25 d`), igual que `exp - iat` real. */
export const JWT_DURATION_UNIT_SECONDS: Readonly<Record<JwtDurationUnit, number>> = Object.freeze({
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
  w: 604_800,
  y: 31_557_600,
});

/**
 * Vigencia máxima de un JWT: con autenticación 100 % stateless (`RN-08`, sin revocación), es la
 * única cota de exposición de un token filtrado o de una cuenta desactivada/degradada.
 */
export const MAX_JWT_EXPIRES_IN_SECONDS = 86_400;
export const MAX_JWT_EXPIRES_IN_LABEL = "1d";

export const JWT_EXPIRES_IN_FORMAT_MESSAGE =
  "JWT_EXPIRES_IN debe tener formato válido con unidad explícita (ej.: 15m, 1h, 1d, 3600s)";
export const JWT_EXPIRES_IN_MAX_MESSAGE = `JWT_EXPIRES_IN no puede superar ${MAX_JWT_EXPIRES_IN_LABEL} (${String(MAX_JWT_EXPIRES_IN_SECONDS)} s): limita la vigencia de tokens stateless sin revocación (RN-08)`;

function isDurationUnit(value: string): value is JwtDurationUnit {
  return Object.hasOwn(JWT_DURATION_UNIT_SECONDS, value);
}

/** Convierte una duración válida a segundos; `null` si el formato no es válido. */
export function jwtExpiresInToSeconds(value: string): number | null {
  const match = JWT_EXPIRES_IN_PATTERN.exec(value);
  const amount = match?.[1];
  const unit = match?.[2];
  if (amount === undefined || unit === undefined || !isDurationUnit(unit)) {
    return null;
  }
  return Number(amount) * JWT_DURATION_UNIT_SECONDS[unit];
}

/** `true` si el valor respeta el formato (independientemente del tope). */
export function hasValidJwtExpiresInFormat(value: string): boolean {
  return jwtExpiresInToSeconds(value) !== null;
}

/** `true` si respeta el formato **y** no supera `MAX_JWT_EXPIRES_IN_SECONDS`. */
export function isAllowedJwtExpiresIn(value: string): value is JwtExpiresIn {
  const seconds = jwtExpiresInToSeconds(value);
  return seconds !== null && seconds <= MAX_JWT_EXPIRES_IN_SECONDS;
}
