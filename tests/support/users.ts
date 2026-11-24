import bcrypt from "bcrypt";
import type express from "express";
import request from "supertest";
import { expect } from "vitest";
import type { Database } from "../../src/infrastructure/database/prisma.js";
import { BCRYPT_SALT_ROUNDS, type UserRole } from "../../src/modules/auth/index.js";

export const TEST_USER_PASSWORD = "test-password-example";

export type CreateUserWithRoleOptions = Readonly<{
  email: string;
  role: UserRole;
  password?: string | undefined;
  firstName?: string | undefined;
  lastName?: string | undefined;
  isActive?: boolean | undefined;
}>;

/**
 * Siembra un usuario con un rol arbitrario directamente por Prisma (Bcrypt real, `RN-08`).
 * Es el único camino para obtener roles privilegiados en pruebas: `POST /auth/register` ya no
 * acepta `role` (#48, ADR-0007).
 */
export async function createUserWithRole(
  db: Database,
  options: CreateUserWithRoleOptions,
): Promise<Readonly<{ id: string; email: string; password: string }>> {
  const password = options.password ?? TEST_USER_PASSWORD;
  const user = await db.prisma.user.create({
    data: {
      email: options.email.trim().toLowerCase(),
      passwordHash: await bcrypt.hash(password, BCRYPT_SALT_ROUNDS),
      firstName: options.firstName ?? "Usuario",
      lastName: options.lastName ?? options.role,
      role: options.role,
      isActive: options.isActive ?? true,
    },
    select: { id: true, email: true },
  });
  return { ...user, password };
}

/** Inicia sesión por HTTP real y devuelve el JWT emitido y el id del usuario. */
export async function loginAs(
  app: express.Express,
  credentials: Readonly<{ email: string; password: string }>,
): Promise<Readonly<{ token: string; userId: string }>> {
  const res = await request(app).post("/api/v1/auth/login").send(credentials);
  expect(res.status).toBe(200);
  return { token: String(res.body.data.token), userId: String(res.body.data.user.id) };
}

/**
 * Crea un usuario con `role` y obtiene su JWT por login HTTP. Un `USER` se registra por
 * `POST /auth/register` (sin `role`, el único camino público); los roles privilegiados se siembran.
 */
export async function registerAndLogin(
  app: express.Express,
  db: Database,
  options: Readonly<{ email: string; role: UserRole }>,
): Promise<Readonly<{ token: string; userId: string }>> {
  if (options.role === "USER") {
    const registerRes = await request(app).post("/api/v1/auth/register").send({
      email: options.email,
      password: TEST_USER_PASSWORD,
      firstName: "Usuario",
      lastName: "Registrado",
    });
    expect(registerRes.status).toBe(201);
    expect(registerRes.body.data.role).toBe("USER");
  } else {
    await createUserWithRole(db, { email: options.email, role: options.role });
  }
  return loginAs(app, { email: options.email, password: TEST_USER_PASSWORD });
}
