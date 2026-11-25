import type { Actor, UserRole } from "../auth/index.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors/app-error.js";
import { canChangeRole } from "./users.policy.js";
import type { IUserAdminRepository, ManagedUser } from "./users.repository.js";

export const USER_NOT_FOUND_MESSAGE = "Usuario no encontrado";
export const SELF_ROLE_CHANGE_FORBIDDEN_MESSAGE = "Un administrador no puede cambiar su propio rol";
export const ACTOR_NOT_ACTIVE_ADMIN_MESSAGE =
  "Tu cuenta ya no es un administrador activo; vuelve a iniciar sesión";
export const LAST_ADMIN_CONFLICT_MESSAGE =
  "No se puede quitar el rol al último administrador activo";

export interface IUserAdminService {
  changeRole(actor: Actor, targetUserId: string, role: UserRole): Promise<ManagedUser>;
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
    switch (result.outcome) {
      case "changed":
      case "unchanged":
        return result.user;
      case "not_found":
        throw new NotFoundError(USER_NOT_FOUND_MESSAGE);
      case "actor_not_admin":
        throw new ForbiddenError(ACTOR_NOT_ACTIVE_ADMIN_MESSAGE);
      case "last_admin":
        throw new ConflictError(LAST_ADMIN_CONFLICT_MESSAGE);
    }
  }
}
