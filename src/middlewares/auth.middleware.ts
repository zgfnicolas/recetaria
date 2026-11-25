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

/**
 * Resuelve el actor de un JWT ya verificado contra su estado **vigente** (#56, ADR-0009): debe
 * devolver `{ id, role }` con el rol actual de la base, o `null` si no existe o está inactivo.
 * Lo implementa `AuthService.resolveActiveActor` (el middleware no accede a Prisma, 4 capas).
 */
export type ActorResolver = (id: string) => Promise<Actor | null>;

export type AuthMiddlewareOptions = Readonly<{
  secret?: string | undefined;
  resolveActor: ActorResolver;
}>;

async function authenticate(
  req: Request,
  next: NextFunction,
  secret: string,
  resolveActor: ActorResolver,
): Promise<void> {
  delete req.user;

  const token = extractBearerToken(req.headers.authorization);
  if (token === null) {
    next(new UnauthorizedError(MISSING_OR_INVALID_AUTH_HEADER_MESSAGE));
    return;
  }

  let claims: Actor;
  try {
    claims = verifyAccessToken(token, secret);
  } catch (err: unknown) {
    next(err instanceof UnauthorizedError ? err : new UnauthorizedError(INVALID_TOKEN_MESSAGE));
    return;
  }

  // El JWT identifica; la base autoriza con el estado vigente (ADR-0009). Un fallo de la base se
  // propaga (5xx redactado), nunca se convierte en 401.
  let current: Actor | null;
  try {
    current = await resolveActor(claims.id);
  } catch (err: unknown) {
    next(err);
    return;
  }
  if (current === null || current.id !== claims.id) {
    // Mismo mensaje que un token inválido: no revela si la cuenta existe o está desactivada.
    next(new UnauthorizedError(INVALID_TOKEN_MESSAGE));
    return;
  }

  req.user = Object.freeze({ id: current.id, role: current.role });
  next();
}

/**
 * Construye el middleware de autenticación (`HS256`, *fail closed*) con DI explícita: verifica la
 * firma y vigencia del JWT y luego resuelve al actor con `resolveActor`, imponiendo su **rol y
 * estado actuales** (un desactivado o inexistente → `401`; un degradado opera con su rol nuevo).
 * Valida `secret` en construcción si se provee; si se omite, falla cerrado con `500` no operacional.
 */
export function createAuthMiddleware(options: AuthMiddlewareOptions): RequestHandler {
  const secret = options.secret;
  if (secret !== undefined) {
    assertValidJwtSecret(secret);
  }
  const { resolveActor } = options;

  return async (req, _res, next) => {
    if (secret === undefined) {
      delete req.user;
      next(new AppError(500, MISSING_JWT_CONFIG_MESSAGE, { isOperational: false }));
      return;
    }

    await authenticate(req, next, secret, resolveActor);
  };
}
