import type { RequestHandler } from "express";
import { USER_ROLES, type UserRole } from "../modules/auth/index.js";
import { ForbiddenError, UnauthorizedError } from "../shared/errors/app-error.js";

const VALID_USER_ROLES: ReadonlySet<string> = new Set(USER_ROLES);

/**
 * Guarda transversal de autorización por rol (RBAC, prevención BFLA).
 * Exige `req.user` autenticado (`401` si falta) y pertenencia a `allowedRoles` (`403` en caso contrario).
 */
export function rbacMiddleware(allowedRoles: readonly UserRole[]): RequestHandler {
  if (allowedRoles.length === 0) {
    throw new RangeError("rbacMiddleware requiere al menos un rol permitido");
  }

  for (const role of allowedRoles) {
    if (!VALID_USER_ROLES.has(role)) {
      throw new RangeError(`Rol inválido en rbacMiddleware: ${String(role)}`);
    }
  }

  const allowedRoleSet: ReadonlySet<UserRole> = new Set(allowedRoles);

  return (req, _res, next) => {
    const actor = req.user;
    if (actor === undefined) {
      next(new UnauthorizedError("Autenticación requerida"));
      return;
    }

    if (!allowedRoleSet.has(actor.role)) {
      next(new ForbiddenError("No tienes permisos para realizar esta acción"));
      return;
    }

    next();
  };
}
