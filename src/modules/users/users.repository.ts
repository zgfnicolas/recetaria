import { z } from "zod";
import type { AppPrismaClient } from "../../infrastructure/database/prisma.js";
import { AppError } from "../../shared/errors/app-error.js";
import { USER_ROLES, type UserRole } from "../auth/index.js";

/** Nombre canónico de la entidad Usuario en `audit_logs` (#53, ADR-0008). */
export const AUDIT_ENTITY_USER = "User";

/** Acciones auditadas sobre Usuarios (#53 roles, #56 estado de la cuenta). */
export type UserAuditAction = "ROLE_CHANGED" | "ACCOUNT_ACTIVATED" | "ACCOUNT_DEACTIVATED";

/** Proyección mínima devuelta al cliente (sin `passwordHash`, `RN-08`). */
export type ManagedUser = Readonly<{ id: string; email: string; role: UserRole; isActive: boolean }>;

export type ChangeRoleWithAuditInput = Readonly<{
  actorId: string;
  targetUserId: string;
  role: UserRole;
}>;

export type ChangeStatusWithAuditInput = Readonly<{
  actorId: string;
  targetUserId: string;
  isActive: boolean;
}>;

/**
 * Resultado común de las operaciones de administración, decidido sobre filas bloqueadas:
 * - `actor_not_admin`: el actor ya no es `ADMIN` activo en la base → `403`.
 * - `not_found` → `404`.
 * - `unchanged`: el destino ya tenía ese valor → `200` idempotente sin auditoría.
 * - `last_admin`: el cambio dejaría el sistema sin `ADMIN` activo → `409` (invariante defensiva:
 *   con el actor revalidado y distinto del destino, siempre queda al menos el actor).
 */
export type UserAdminResult =
  | Readonly<{ outcome: "changed"; user: ManagedUser }>
  | Readonly<{ outcome: "unchanged"; user: ManagedUser }>
  | Readonly<{ outcome: "not_found" }>
  | Readonly<{ outcome: "actor_not_admin" }>
  | Readonly<{ outcome: "last_admin" }>;

export interface IUserAdminRepository {
  /** Cambia el rol e inserta `ROLE_CHANGED` en `audit_logs` en la misma transacción (`RN-09`). */
  changeRoleWithAudit(input: ChangeRoleWithAuditInput): Promise<UserAdminResult>;
  /** Activa o desactiva la cuenta e inserta `ACCOUNT_*` en la misma transacción (`RN-10`). */
  changeStatusWithAudit(input: ChangeStatusWithAuditInput): Promise<UserAdminResult>;
}

const MANAGED_USER_SELECT = { id: true, email: true, role: true, isActive: true } as const;

const lockedAdminRowSchema = z.object({ id: z.string() });
const lockedTargetRowSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(USER_ROLES),
  isActive: z.boolean(),
});

type TransactionClient = Parameters<Parameters<AppPrismaClient["$transaction"]>[0]>[0];

/** Lectura defensiva de filas `$queryRaw` (no tipadas en runtime): inconsistencia → `500`. */
function parseRows<T>(schema: z.ZodType<T>, rows: unknown[]): T[] {
  const parsed = z.array(schema).safeParse(rows);
  if (!parsed.success) {
    throw new AppError(500, "Filas de usuario bloqueadas con formato inválido", {
      isOperational: false,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * Paso 1 del orden fijo de bloqueo: `SELECT … FOR NO KEY UPDATE` de **todos** los `ADMIN` activos
 * (`ORDER BY id`). Revalida al actor y serializa los cambios concurrentes entre `ADMIN`.
 */
async function lockActiveAdmins(tx: TransactionClient): Promise<string[]> {
  return parseRows(
    lockedAdminRowSchema,
    await tx.$queryRaw<unknown[]>`
      SELECT id FROM "users" WHERE role = 'ADMIN' AND "isActive" = true
      ORDER BY id FOR NO KEY UPDATE`,
  ).map((row) => row.id);
}

/** Paso 2 del orden fijo de bloqueo: el usuario destino (`null` si no existe). */
async function lockManagedUser(tx: TransactionClient, id: string): Promise<ManagedUser | null> {
  const [row] = parseRows(
    lockedTargetRowSchema,
    await tx.$queryRaw<unknown[]>`
      SELECT id, email, role, "isActive" FROM "users"
      WHERE id = ${id}::uuid FOR NO KEY UPDATE`,
  );
  return row ?? null;
}

/** `true` si, tras el cambio, ya no quedaría ningún `ADMIN` activo. */
function wouldLeaveNoActiveAdmin(
  activeAdmins: readonly string[],
  target: ManagedUser,
  after: Readonly<{ role: UserRole; isActive: boolean }>,
): boolean {
  const targetIsActiveAdmin = target.role === "ADMIN" && target.isActive;
  const remainsActiveAdmin = after.role === "ADMIN" && after.isActive;
  return targetIsActiveAdmin && !remainsActiveAdmin && activeAdmins.every((id) => id === target.id);
}

/**
 * Repositorio Prisma de administración de Usuarios (#53, #56), único punto de acceso a la base del
 * módulo `users`. No expone `passwordHash`.
 */
export class UserAdminRepository implements IUserAdminRepository {
  readonly #prisma: AppPrismaClient;

  constructor(prisma: AppPrismaClient) {
    this.#prisma = prisma;
  }

  /**
   * Transacción interactiva `READ COMMITTED` con orden fijo de bloqueo (evita interbloqueos):
   * 1. `lockActiveAdmins`: revalida que el actor siga siendo `ADMIN` activo (antes de buscar al
   *    destino, sin revelar si existe).
   * 2. `lockManagedUser` del destino.
   * 3. `UPDATE` del rol + `ROLE_CHANGED` en `audit_logs` (`oldValues`/`newValues`).
   * `NO KEY UPDATE` (solo cambian columnas no clave) no bloquea los `KEY SHARE` de las FK de otras
   * operaciones. La fila del actor queda bloqueada: no puede borrarse mientras actúa.
   */
  async changeRoleWithAudit(input: ChangeRoleWithAuditInput): Promise<UserAdminResult> {
    return this.#prisma.$transaction(async (tx): Promise<UserAdminResult> => {
      const activeAdmins = await lockActiveAdmins(tx);
      if (!activeAdmins.includes(input.actorId)) {
        return { outcome: "actor_not_admin" };
      }
      const target = await lockManagedUser(tx, input.targetUserId);
      if (target === null) {
        return { outcome: "not_found" };
      }
      if (target.role === input.role) {
        return { outcome: "unchanged", user: target };
      }
      if (wouldLeaveNoActiveAdmin(activeAdmins, target, { role: input.role, isActive: target.isActive })) {
        return { outcome: "last_admin" };
      }

      const updated = await tx.user.update({
        where: { id: target.id },
        data: { role: input.role },
        select: MANAGED_USER_SELECT,
      });
      await tx.auditLog.create({
        data: {
          entityName: AUDIT_ENTITY_USER,
          entityId: target.id,
          action: "ROLE_CHANGED" satisfies UserAuditAction,
          userId: input.actorId,
          oldValues: { role: target.role },
          newValues: { role: input.role },
        },
      });
      return { outcome: "changed", user: updated };
    });
  }

  /**
   * Mismo orden fijo de bloqueo que `changeRoleWithAudit` (#56): revalida al actor, bloquea al
   * destino y, si cambia, actualiza `isActive` + `ACCOUNT_ACTIVATED`/`ACCOUNT_DEACTIVATED` con
   * `oldValues`/`newValues = { isActive }` en la misma transacción.
   */
  async changeStatusWithAudit(input: ChangeStatusWithAuditInput): Promise<UserAdminResult> {
    return this.#prisma.$transaction(async (tx): Promise<UserAdminResult> => {
      const activeAdmins = await lockActiveAdmins(tx);
      if (!activeAdmins.includes(input.actorId)) {
        return { outcome: "actor_not_admin" };
      }
      const target = await lockManagedUser(tx, input.targetUserId);
      if (target === null) {
        return { outcome: "not_found" };
      }
      if (target.isActive === input.isActive) {
        return { outcome: "unchanged", user: target };
      }
      if (wouldLeaveNoActiveAdmin(activeAdmins, target, { role: target.role, isActive: input.isActive })) {
        return { outcome: "last_admin" };
      }

      const updated = await tx.user.update({
        where: { id: target.id },
        data: { isActive: input.isActive },
        select: MANAGED_USER_SELECT,
      });
      await tx.auditLog.create({
        data: {
          entityName: AUDIT_ENTITY_USER,
          entityId: target.id,
          action: (input.isActive ? "ACCOUNT_ACTIVATED" : "ACCOUNT_DEACTIVATED") satisfies UserAuditAction,
          userId: input.actorId,
          oldValues: { isActive: target.isActive },
          newValues: { isActive: input.isActive },
        },
      });
      return { outcome: "changed", user: updated };
    });
  }
}
