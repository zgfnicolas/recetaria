import type { Actor } from "../auth/index.js";

/**
 * Política pura (`RN-09`): un `ADMIN` no puede cambiar su propio rol. Evita autodegradaciones
 * accidentales y la pérdida del último acceso de moderación. El rol `ADMIN` lo exige RBAC.
 */
export function canChangeRole(actor: Actor, targetUserId: string): boolean {
  return actor.id !== targetUserId;
}

/**
 * Política pura (`RN-10`): un `ADMIN` no puede desactivar ni reactivar su propia cuenta (evita
 * perder el acceso de moderación por error). El rol `ADMIN` lo exige RBAC.
 */
export function canChangeStatus(actor: Actor, targetUserId: string): boolean {
  return actor.id !== targetUserId;
}
