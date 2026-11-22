import type { Router } from "express";
import type { AppPrismaClient } from "../infrastructure/database/prisma.js";
import {
  AuthController,
  AuthService,
  createAuthRouter,
  UserRepository,
} from "../modules/auth/index.js";
import type { ReadinessDatabaseClient } from "../shared/http/health.router.js";

export type MountedRouter = Readonly<{
  path: string;
  router: Router;
}>;

/**
 * Determina si el cliente recibido implementa el modelo Prisma completo
 * (diferenciándolo de stubs mínimos de solo `$queryRaw` para sondas de salud).
 */
export function isAppPrismaClient(
  prisma: AppPrismaClient | ReadinessDatabaseClient | undefined,
): prisma is AppPrismaClient {
  return (
    prisma !== undefined &&
    "user" in prisma &&
    typeof prisma.user === "object" &&
    prisma.user !== null
  );
}

/**
 * Composition root por aplicación: ensambla repositorios, servicios, controladores y routers `/api/v1`.
 */
export function buildApiRouters(prisma: AppPrismaClient): readonly MountedRouter[] {
  const userRepository = new UserRepository(prisma);
  const authService = new AuthService(userRepository);
  const authController = new AuthController(authService);
  const authRouter = createAuthRouter(authController);

  return [{ path: "/auth", router: authRouter }];
}
