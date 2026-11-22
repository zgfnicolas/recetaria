import { z } from "zod";

export const USER_ROLES = ["USER", "CHEF", "NUTRITIONIST", "ADMIN"] as const;

export type UserRole = (typeof USER_ROLES)[number];

/** Límite máximo aceptado por Bcrypt sin truncar octetos UTF-8. */
export const MAX_BCRYPT_PASSWORD_BYTES = 72;

const emailFieldSchema = z
  .string({ error: "El correo electrónico es obligatorio" })
  .trim()
  .toLowerCase()
  .max(255, { error: "El correo electrónico no puede superar los 255 caracteres" })
  .pipe(z.email({ error: "Formato de email inválido" }));

/**
 * Esquema estricto de validación de entrada para `POST /api/v1/auth/register`.
 * Rechaza propiedades extra (BOPLA) y acota la contraseña a 72 bytes UTF-8.
 */
export const registerSchema = z.strictObject({
  email: emailFieldSchema,
  password: z
    .string({ error: "La contraseña es obligatoria" })
    .min(8, { error: "La contraseña debe tener al menos 8 caracteres" })
    .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_BCRYPT_PASSWORD_BYTES, {
      error: "La contraseña no puede superar los 72 bytes UTF-8",
    }),
  firstName: z
    .string({ error: "El nombre es obligatorio" })
    .trim()
    .min(2, { error: "El nombre debe tener al menos 2 caracteres" })
    .max(100, { error: "El nombre no puede superar los 100 caracteres" }),
  lastName: z
    .string({ error: "El apellido es obligatorio" })
    .trim()
    .min(2, { error: "El apellido debe tener al menos 2 caracteres" })
    .max(100, { error: "El apellido no puede superar los 100 caracteres" }),
  role: z.enum(USER_ROLES, { error: "Rol inválido" }).default("USER"),
});

/**
 * Esquema estricto de validación de entrada para `POST /api/v1/auth/login`.
 * Normaliza email y exige contraseña no vacía sin aplicar `.trim()` sobre ella.
 */
export const loginSchema = z.strictObject({
  email: emailFieldSchema,
  password: z
    .string({ error: "La contraseña es obligatoria" })
    .min(1, { error: "La contraseña es obligatoria" }),
});

export type RegisterDTO = z.infer<typeof registerSchema>;
export type LoginDTO = z.infer<typeof loginSchema>;
