import jwt from "jsonwebtoken";
import type { JwtExpiresIn } from "../../config/env.js";
import type { UserRole } from "./auth.schema.js";

export const JWT_ALGORITHM = "HS256" as const;
export const MIN_JWT_SECRET_LENGTH = 32;

const JWT_EXPIRES_IN_PATTERN = /^[1-9]\d{0,5}(s|m|h|d|w|y)$/;

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
 * Valida de forma estricta secreto y expiración JWT antes de firmar tokens (*fail closed*).
 */
export function assertValidJwtConfig(config: JwtConfig): void {
  if (config.secret.replace(/\s+/g, "").length < MIN_JWT_SECRET_LENGTH) {
    throw new RangeError(
      `JWT_SECRET inválido: debe contener al menos ${String(MIN_JWT_SECRET_LENGTH)} caracteres distintos de espacios`,
    );
  }
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
