import jwt from "jsonwebtoken";
import { z } from "zod";
import {
  isAllowedJwtExpiresIn,
  JWT_EXPIRES_IN_FORMAT_MESSAGE,
  JWT_EXPIRES_IN_MAX_MESSAGE,
  jwtExpiresInToSeconds,
  MAX_JWT_EXPIRES_IN_SECONDS,
  type JwtExpiresIn,
} from "../../config/jwt-expires-in.js";
import { UnauthorizedError } from "../../shared/errors/app-error.js";
import { USER_ROLES, type UserRole } from "./auth.schema.js";

export const JWT_ALGORITHM = "HS256" as const;
export const MIN_JWT_SECRET_LENGTH = 32;
export const INVALID_TOKEN_MESSAGE = "Token inválido o expirado";
/**
 * Tolerancia de desfase de reloj para `iat` (#22): un token no puede declararse emitido más de
 * estos segundos en el futuro. Sin este límite, `iat` futuro + `exp - iat ≤ 1d` dejaba vigente un
 * token durante años (anulando el tope de #52) si se filtraba el secreto.
 */
export const JWT_CLOCK_TOLERANCE_SECONDS = 30;

const DISALLOWED_TOKEN_CHARS_PATTERN = /[\s\u0000-\u001f\u007f-\u009f]/;

/** Esquema Zod 4 de claims mínimos `{ id, role }` extraídos del payload JWT. */
export const accessTokenPayloadSchema = z.object({
  id: z.uuid(),
  role: z.enum(USER_ROLES),
});

/** Claims mínimos del portador JWT en Recetaria API (`ADR-0004`). */
export type Actor = Readonly<{
  id: string;
  role: UserRole;
}>;

export type JwtConfig = Readonly<{
  secret: string;
  expiresIn: JwtExpiresIn;
}>;

/**
 * Valida de forma estricta el secreto JWT antes de firmar o verificar tokens (*fail closed*).
 */
export function assertValidJwtSecret(secret: string): void {
  if (secret.replace(/\s+/g, "").length < MIN_JWT_SECRET_LENGTH) {
    throw new RangeError(
      `JWT_SECRET inválido: debe contener al menos ${String(MIN_JWT_SECRET_LENGTH)} caracteres distintos de espacios`,
    );
  }
}

/**
 * Valida de forma estricta secreto y expiración JWT antes de firmar tokens (*fail closed*):
 * misma regla de formato y tope (`1d`, #52) que la validación de arranque, para que una app
 * construida programáticamente (`buildApp({ jwt })`) tampoco emita tokens de vigencia excesiva.
 */
export function assertValidJwtConfig(config: JwtConfig): void {
  assertValidJwtSecret(config.secret);
  if (!isAllowedJwtExpiresIn(config.expiresIn)) {
    // Mismo par de mensajes que el arranque: formato inválido vs. vigencia excesiva (#52)
    const reason =
      jwtExpiresInToSeconds(config.expiresIn) === null
        ? JWT_EXPIRES_IN_FORMAT_MESSAGE
        : JWT_EXPIRES_IN_MAX_MESSAGE;
    throw new RangeError(`${reason} (recibido: ${String(config.expiresIn)})`);
  }
}

/**
 * Firma un token Bearer JWT stateless exclusivamente con `HS256` y claims mínimos `{ id, role }`.
 */
export function signAccessToken(actor: Actor, config: JwtConfig): string {
  assertValidJwtConfig(config);

  return jwt.sign({ id: actor.id, role: actor.role }, config.secret, {
    algorithm: JWT_ALGORITHM,
    expiresIn: config.expiresIn,
  });
}

/**
 * Verifica un Bearer JWT stateless exclusivamente con `algorithms: ["HS256"]`,
 * valida `{ id: UUID, role: Role }` con Zod 4 y retorna un `Actor` congelado (*fail closed*).
 * Defensa en profundidad del tope (#52): exige `iat` y `exp` numéricos, una antigüedad no mayor que
 * `MAX_JWT_EXPIRES_IN_SECONDS` (`maxAge`), una vigencia declarada `exp - iat` dentro del tope y un
 * `iat` no posterior a `ahora + JWT_CLOCK_TOLERANCE_SECONDS` (#22), así que ni un token sin `exp`
 * ni uno con `exp` lejano (directo o vía `iat` futuro, aun firmado con el secreto) son aceptados:
 * todo token aceptado vence, como máximo, en `ahora + 1d + tolerancia`.
 * Lanza `RangeError` si `secret` es inválido y `UnauthorizedError` ante cualquier fallo del token.
 */
export function verifyAccessToken(token: string, secret: string): Actor {
  assertValidJwtSecret(secret);

  if (token.length === 0 || DISALLOWED_TOKEN_CHARS_PATTERN.test(token)) {
    throw new UnauthorizedError(INVALID_TOKEN_MESSAGE);
  }

  let decoded: string | jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, secret, {
      algorithms: [JWT_ALGORITHM],
      maxAge: MAX_JWT_EXPIRES_IN_SECONDS,
    });
  } catch {
    throw new UnauthorizedError(INVALID_TOKEN_MESSAGE);
  }

  if (
    typeof decoded !== "object" ||
    typeof decoded.iat !== "number" ||
    typeof decoded.exp !== "number" ||
    decoded.exp - decoded.iat > MAX_JWT_EXPIRES_IN_SECONDS ||
    decoded.iat > Math.floor(Date.now() / 1000) + JWT_CLOCK_TOLERANCE_SECONDS
  ) {
    throw new UnauthorizedError(INVALID_TOKEN_MESSAGE);
  }

  const parsed = accessTokenPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new UnauthorizedError(INVALID_TOKEN_MESSAGE);
  }

  return Object.freeze({
    id: parsed.data.id,
    role: parsed.data.role,
  });
}
