import type { Actor, UserRole } from "../auth/index.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors/app-error.js";
import { canChangeRole, canChangeStatus } from "./users.policy.js";
import type { IUserAdminRepository, ManagedUser, UserAdminResult } from "./users.repository.js";

export const USER_NOT_FOUND_MESSAGE = "Usuario no encontrado";
export const SELF_ROLE_CHANGE_FORBIDDEN_MESSAGE = "Un administrador no puede cambiar su propio rol";
export const ACTOR_NOT_ACTIVE_ADMIN_MESSAGE =
  "Tu cuenta ya no es un administrador activo; vuelve a iniciar sesión";
export const LAST_ADMIN_CONFLICT_MESSAGE =
  "No se puede quitar el rol al último administrador activo";
export const SELF_STATUS_CHANGE_FORBIDDEN_MESSAGE =
  "Un administrador no puede cambiar el estado de su propia cuenta";
export const LAST_ADMIN_DEACTIVATION_CONFLICT_MESSAGE =
  "No se puede desactivar al último administrador activo";

export interface IUserAdminService {
  changeRole(actor: Actor, targetUserId: string, role: UserRole): Promise<ManagedUser>;
  changeStatus(actor: Actor, targetUserId: string, isActive: boolean): Promise<ManagedUser>;
}

/**
 * Servicio de administración de roles (`RN-09`, #53). Orden: `403` si el actor intenta cambiar su
 * propio rol (puro, sin consultar la base), `403` si ya no es `ADMIN` activo en la base, `404` si el
 * destino no existe y `409` si quedaría sin `ADMIN` activo. El actor se revalida **antes** de buscar
 * al destino, así un `ADMIN` degradado no puede distinguir usuarios existentes (`404` vs `403`).
 * El cambio y su auditoría son atómicos en el repositorio.
 */
export class UserAdminService implements IUserAdminService {
  readonly #repository: IUserAdminRepository;

  constructor(repository: IUserAdminRepository) {
    this.#repository = repository;
  }

  async changeRole(actor: Actor, targetUserId: string, role: UserRole): Promise<ManagedUser> {
    if (!canChangeRole(actor, targetUserId)) {
      throw new ForbiddenError(SELF_ROLE_CHANGE_FORBIDDEN_MESSAGE);
    }

    const result = await this.#repository.changeRoleWithAudit({
      actorId: actor.id,
      targetUserId,
      role,
    });
    return unwrap(result, LAST_ADMIN_CONFLICT_MESSAGE);
  }

  /**
   * Activación y desactivación de cuentas (`RN-10`, #56), con el mismo orden de guardas que
   * `changeRole`: `403` auto-modificación → `403` actor no activo → `404` → `409` último `ADMIN`.
   * Desactivar rige de inmediato en toda la API, porque `authMiddleware` resuelve el estado vigente
   * (ADR-0009).
   */
  async changeStatus(actor: Actor, targetUserId: string, isActive: boolean): Promise<ManagedUser> {
    if (!canChangeStatus(actor, targetUserId)) {
      throw new ForbiddenError(SELF_STATUS_CHANGE_FORBIDDEN_MESSAGE);
    }
    const result = await this.#repository.changeStatusWithAudit({
      actorId: actor.id,
      targetUserId,
      isActive,
    });
    return unwrap(result, LAST_ADMIN_DEACTIVATION_CONFLICT_MESSAGE);
  }
}

/** Traduce el resultado del repositorio al usuario devuelto o al error HTTP correspondiente. */
function unwrap(result: UserAdminResult, lastAdminMessage: string): ManagedUser {
  switch (result.outcome) {
    case "changed":
    case "unchanged":
      return result.user;
    case "not_found":
      throw new NotFoundError(USER_NOT_FOUND_MESSAGE);
    case "actor_not_admin":
      throw new ForbiddenError(ACTOR_NOT_ACTIVE_ADMIN_MESSAGE);
    case "last_admin":
      throw new ConflictError(lastAdminMessage);
  }
}
