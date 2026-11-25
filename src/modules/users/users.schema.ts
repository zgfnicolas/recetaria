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

export type UserIdParamsDTO = z.infer<typeof userIdParamsSchema>;
export type ChangeRoleDTO = z.infer<typeof changeRoleSchema>;
