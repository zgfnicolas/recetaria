import type { NextFunction, Request, RequestHandler } from "express";
import {
  assertValidJwtSecret,
  INVALID_TOKEN_MESSAGE,
  verifyAccessToken,
  type Actor,
} from "../modules/auth/index.js";
import { AppError, UnauthorizedError } from "../shared/errors/app-error.js";

const BEARER_PREFIX = "Bearer ";
const DISALLOWED_TOKEN_CHARS_PATTERN = /[\s\u0000-\u001f\u007f-\u009f]/;
const MISSING_OR_INVALID_AUTH_HEADER_MESSAGE = "Token de autenticación requerido";
const MISSING_JWT_CONFIG_MESSAGE = "Configuración JWT no inicializada";

/**
 * Tipo auxiliar para controladores posteriores a `authMiddleware`,
 * garantizando la presencia estrictamente tipada de `req.user`.
 */
export type AuthenticatedRequest = Request & {
  readonly user: Actor;
};

declare global {
  namespace Express {
    interface Request {
      user?: Actor;
    }
  }
}

export type AuthMiddlewareOptions = Readonly<{
  secret?: string | undefined;
}>;

/**
 * Extrae el token del encabezado `Authorization` exigiendo prefijo estricto `Bearer `
 * (sensible a mayúsculas) y rechazando tokens vacíos, espacios o caracteres de control.
 */
export function extractBearerToken(
  authorizationHeader: string | readonly string[] | undefined,
): string | null {
  if (typeof authorizationHeader !== "string" || !authorizationHeader.startsWith(BEARER_PREFIX)) {
    return null;
  }

  const token = authorizationHeader.slice(BEARER_PREFIX.length);
  if (token.length === 0 || DISALLOWED_TOKEN_CHARS_PATTERN.test(token)) {
    return null;
  }

  return token;
}

function authenticateWithSecret(req: Request, next: NextFunction, secret: string): void {
  delete req.user;

  const token = extractBearerToken(req.headers.authorization);
  if (token === null) {
    next(new UnauthorizedError(MISSING_OR_INVALID_AUTH_HEADER_MESSAGE));
    return;
  }

  let actor: Actor;
  try {
    actor = verifyAccessToken(token, secret);
  } catch (err: unknown) {
    delete req.user;
    if (err instanceof UnauthorizedError) {
      next(err);
      return;
    }
    next(new UnauthorizedError(INVALID_TOKEN_MESSAGE));
    return;
  }

  req.user = actor;
  next();
}

function readValidEnvJwtSecret(): string | null {
  const candidate = process.env["JWT_SECRET"];
  if (typeof candidate !== "string") {
    return null;
  }
  try {
    assertValidJwtSecret(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Construye un middleware de autenticación JWT stateless (`HS256`, *fail closed*) con DI explícita.
 * Valida `secret` en construcción si se provee; si se omite, falla cerrado con `500` no operacional.
 */
export function createAuthMiddleware(options?: AuthMiddlewareOptions): RequestHandler {
  const secret = options?.secret;
  if (secret !== undefined) {
    assertValidJwtSecret(secret);
  }

  return (req, _res, next) => {
    if (secret === undefined) {
      delete req.user;
      next(new AppError(500, MISSING_JWT_CONFIG_MESSAGE, { isOperational: false }));
      return;
    }

    authenticateWithSecret(req, next, secret);
  };
}

/**
 * Middleware de autenticación JWT stateless por defecto sobre `process.env["JWT_SECRET"]` (*fail closed*).
 * En composición explícita (`bootstrap/container.ts`, pruebas) preferir `createAuthMiddleware({ secret })`.
 */
export const authMiddleware: RequestHandler = (req, _res, next) => {
  const secret = readValidEnvJwtSecret();
  if (secret === null) {
    delete req.user;
    next(new AppError(500, MISSING_JWT_CONFIG_MESSAGE, { isOperational: false }));
    return;
  }

  authenticateWithSecret(req, next, secret);
};
