import { z } from "zod";
import type { AppPrismaClient } from "../../infrastructure/database/prisma.js";
import { AppError } from "../../shared/errors/app-error.js";
import { USER_ROLES, type UserRole } from "../auth/index.js";

/** Nombre canónico de la entidad Usuario en `audit_logs` (#53, ADR-0008). */
export const AUDIT_ENTITY_USER = "User";

/** Acciones auditadas sobre Usuarios (#53). */
export type UserAuditAction = "ROLE_CHANGED";

/** Proyección mínima devuelta al cliente (sin `passwordHash`, `RN-08`). */
export type ManagedUser = Readonly<{ id: string; email: string; role: UserRole }>;

export type ChangeRoleWithAuditInput = Readonly<{
  actorId: string;
  targetUserId: string;
  role: UserRole;
}>;

/**
 * Resultado de `changeRoleWithAudit`, decidido sobre filas bloqueadas:
 * - `actor_not_admin`: el actor ya no es `ADMIN` activo en la base (JWT vigente pero degradado) → `403`.
 * - `not_found` → `404`.
 * - `unchanged`: el destino ya tenía ese rol → `200` idempotente sin auditoría.
 * - `last_admin`: el cambio dejaría el sistema sin `ADMIN` activo → `409` (invariante defensiva:
 *   con el actor revalidado y distinto del destino, siempre queda al menos el actor).
 */
export type ChangeRoleWithAuditResult =
  | Readonly<{ outcome: "changed"; user: ManagedUser }>
  | Readonly<{ outcome: "unchanged"; user: ManagedUser }>
  | Readonly<{ outcome: "not_found" }>
  | Readonly<{ outcome: "actor_not_admin" }>
  | Readonly<{ outcome: "last_admin" }>;

export interface IUserAdminRepository {
  /** Cambia el rol e inserta `ROLE_CHANGED` en `audit_logs` en la misma transacción (`RN-09`). */
  changeRoleWithAudit(input: ChangeRoleWithAuditInput): Promise<ChangeRoleWithAuditResult>;
}

const MANAGED_USER_SELECT = { id: true, email: true, role: true } as const;

const lockedAdminRowSchema = z.object({ id: z.string() });
const lockedTargetRowSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(USER_ROLES),
  isActive: z.boolean(),
});

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
 * Repositorio Prisma de administración de Usuarios (#53), único punto de acceso a la base del
 * módulo `users`. No expone `passwordHash`.
 */
export class UserAdminRepository implements IUserAdminRepository {
  readonly #prisma: AppPrismaClient;

  constructor(prisma: AppPrismaClient) {
    this.#prisma = prisma;
  }

  /**
   * Transacción interactiva `READ COMMITTED` con orden fijo de bloqueo (evita interbloqueos):
   * 1. `SELECT … FOR NO KEY UPDATE` de **todos** los `ADMIN` activos (`ORDER BY id`): revalida que
   *    el actor siga siéndolo (antes de buscar al destino, sin revelar si existe) y serializa los
   *    cambios concurrentes entre `ADMIN`.
   * 2. `SELECT … FOR NO KEY UPDATE` del destino.
   * 3. `UPDATE` del rol + `ROLE_CHANGED` en `audit_logs` (`oldValues`/`newValues`).
   * `NO KEY UPDATE` (solo cambia `role`, columna no clave) no bloquea los `KEY SHARE` de las FK
   * (p. ej. inserciones en `audit_logs` de otras operaciones del mismo `ADMIN`). La fila del actor
   * queda bloqueada, así que no puede borrarse mientras actúa (sin rama `P2003`).
   */
  async changeRoleWithAudit(input: ChangeRoleWithAuditInput): Promise<ChangeRoleWithAuditResult> {
    return this.#prisma.$transaction(async (tx): Promise<ChangeRoleWithAuditResult> => {
        const activeAdmins = parseRows(
          lockedAdminRowSchema,
          await tx.$queryRaw<unknown[]>`
            SELECT id FROM "users" WHERE role = 'ADMIN' AND "isActive" = true
            ORDER BY id FOR NO KEY UPDATE`,
        ).map((row) => row.id);
        if (!activeAdmins.includes(input.actorId)) {
          return { outcome: "actor_not_admin" };
        }

        const [target] = parseRows(
          lockedTargetRowSchema,
          await tx.$queryRaw<unknown[]>`
            SELECT id, email, role, "isActive" FROM "users"
            WHERE id = ${input.targetUserId}::uuid FOR NO KEY UPDATE`,
        );
        if (target === undefined) {
          return { outcome: "not_found" };
        }
        if (target.role === input.role) {
          return { outcome: "unchanged", user: { id: target.id, email: target.email, role: target.role } };
        }

        const removesActiveAdmin = target.role === "ADMIN" && target.isActive && input.role !== "ADMIN";
        const remainingAdmins = activeAdmins.filter((id) => id !== target.id);
        if (removesActiveAdmin && remainingAdmins.length === 0) {
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
}
