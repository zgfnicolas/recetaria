import type { Router } from "express";
import type { AppPrismaClient } from "../infrastructure/database/prisma.js";
import {
  AuthController,
  AuthService,
  createAuthRouter,
  UserRepository,
  type JwtConfig,
} from "../modules/auth/index.js";
import { createAuthMiddleware } from "../middlewares/auth.middleware.js";
import {
  createRateLimitMiddleware,
  DEFAULT_PUBLIC_READ_RATE_LIMIT,
  type RateLimitConfig,
} from "../middlewares/rate-limit.middleware.js";
import {
  createRecipeRouter,
  RecipeController,
  RecipeRepository,
  RecipeService,
} from "../modules/recipes/index.js";
import type { ReadinessDatabaseClient } from "../shared/http/health.router.js";

export type { JwtConfig } from "../modules/auth/index.js";

export type MountedRouter = Readonly<{
  path: string;
  router: Router;
}>;

export type BuildApiRoutersOptions = Readonly<{
  jwt?: JwtConfig | undefined;
  /** Rate limit del catálogo público; `false` lo desactiva (solo pruebas que no lo ejercitan). */
  publicRateLimit?: RateLimitConfig | false | undefined;
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
export function buildApiRouters(
  prisma: AppPrismaClient,
  options?: BuildApiRoutersOptions,
): readonly MountedRouter[] {
  const userRepository = new UserRepository(prisma);
  const authService = new AuthService(userRepository, { jwt: options?.jwt });
  const authController = new AuthController(authService);
  const authRouter = createAuthRouter(authController);

  // Guarda JWT con DI explícita: sin `jwt` falla cerrado (500 redactado) en cada request protegida.
  const authGuard = createAuthMiddleware({ secret: options?.jwt?.secret });

  const recipeRepository = new RecipeRepository(prisma);
  const recipeService = new RecipeService(recipeRepository);
  const recipeController = new RecipeController(recipeService);
  const publicRateLimit = options?.publicRateLimit ?? DEFAULT_PUBLIC_READ_RATE_LIMIT;
  const publicReadLimiter =
    publicRateLimit === false ? undefined : createRateLimitMiddleware(publicRateLimit);
  const recipeRouter = createRecipeRouter(recipeController, authGuard, { publicReadLimiter });

  return [
    { path: "/auth", router: authRouter },
    { path: "/recipes", router: recipeRouter },
  ];
}
