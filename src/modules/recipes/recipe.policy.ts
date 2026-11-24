import type { Actor, UserRole } from "../auth/index.js";
import type { RecipeRecord } from "./recipe.repository.js";

/**
 * Roles de Revisor Profesional habilitados para aprobar Recetas (`RN-04`).
 * Fuente única para `rbacMiddleware` (router) y para `canApprove` (servicio).
 */
export const RECIPE_APPROVER_ROLES = ["CHEF", "NUTRITIONIST"] as const satisfies readonly UserRole[];

const APPROVER_ROLE_SET: ReadonlySet<UserRole> = new Set(RECIPE_APPROVER_ROLES);

/**
 * Política pura de Aprobación: rol profesional (`RN-04`) **y** separación de funciones
 * (`recipe.authorId !== actor.id`, `RN-05`). No depende de HTTP ni de la base de datos.
 */
export function canApprove(actor: Actor, recipe: Pick<RecipeRecord, "authorId">): boolean {
  return APPROVER_ROLE_SET.has(actor.role) && recipe.authorId !== actor.id;
}

/**
 * Política pura de Edición (`RN-02`): solo el Autor original (`recipe.authorId === actor.id`).
 * Ningún rol tiene excepción, ni siquiera `ADMIN` (`docs/roles.md`).
 */
export function canEdit(actor: Actor, recipe: Pick<RecipeRecord, "authorId">): boolean {
  return recipe.authorId === actor.id;
}
