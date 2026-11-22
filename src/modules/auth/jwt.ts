import jwt from "jsonwebtoken";
import { z } from "zod";
import type { JwtExpiresIn } from "../../config/env.js";
import { UnauthorizedError } from "../../shared/errors/app-error.js";
import { USER_ROLES, type UserRole } from "./auth.schema.js";

export const JWT_ALGORITHM = "HS256" as const;
export const MIN_JWT_SECRET_LENGTH = 32;
export const INVALID_TOKEN_MESSAGE = "Token inválido o expirado";

const JWT_EXPIRES_IN_PATTERN = /^[1-9]\d{0,5}(s|m|h|d|w|y)$/;
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
 * Valida de forma estricta secreto y expiración JWT antes de firmar tokens (*fail closed*).
 */
export function assertValidJwtConfig(config: JwtConfig): void {
  assertValidJwtSecret(config.secret);
  if (!JWT_EXPIRES_IN_PATTERN.test(config.expiresIn)) {
    throw new RangeError(`JWT_EXPIRES_IN inválido: ${String(config.expiresIn)}`);
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
 * Lanza `RangeError` si `secret` es inválido y `UnauthorizedError` ante cualquier fallo del token.
 */
export function verifyAccessToken(token: string, secret: string): Actor {
  assertValidJwtSecret(secret);

  if (token.length === 0 || DISALLOWED_TOKEN_CHARS_PATTERN.test(token)) {
    throw new UnauthorizedError(INVALID_TOKEN_MESSAGE);
  }

  let decoded: string | jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, secret, { algorithms: [JWT_ALGORITHM] });
  } catch {
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
