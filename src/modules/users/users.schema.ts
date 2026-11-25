import { z } from "zod";
import { USER_ROLES } from "../auth/index.js";

/** Parámetro `:id` del Usuario administrado: UUID v4 (`gen_random_uuid()`). */
export const userIdParamsSchema = z.strictObject({
  id: z.uuidv4({ error: "id debe ser un UUID v4 válido" }),
});

/**
 * Body estricto de `PATCH /api/v1/users/:id/role` (#53): solo `role`; cualquier otro campo
 * (`isActive`, `email`, `passwordHash`…) responde `400` "Campo no permitido" (BOPLA).
 */
export const changeRoleSchema = z.strictObject({
  role: z.enum(USER_ROLES, { error: "Rol inválido" }),
});

/**
 * Body estricto de `PATCH /api/v1/users/:id/status` (#56): solo `isActive` booleano (sin coerción:
 * `"false"`, `0` o `null` → `400`); cualquier otro campo → `400` "Campo no permitido" (BOPLA).
 */
export const changeStatusSchema = z.strictObject({
  isActive: z.boolean({ error: "isActive debe ser un booleano" }),
});

export type UserIdParamsDTO = z.infer<typeof userIdParamsSchema>;
export type ChangeStatusDTO = z.infer<typeof changeStatusSchema>;
export type ChangeRoleDTO = z.infer<typeof changeRoleSchema>;
