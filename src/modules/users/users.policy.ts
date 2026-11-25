import type { Actor } from "../auth/index.js";

/**
 * Política pura (`RN-09`): un `ADMIN` no puede cambiar su propio rol. Evita autodegradaciones
 * accidentales y la pérdida del último acceso de moderación. El rol `ADMIN` lo exige RBAC.
 */
export function canChangeRole(actor: Actor, targetUserId: string): boolean {
  return actor.id !== targetUserId;
}
