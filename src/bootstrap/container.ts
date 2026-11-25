import type { RequestHandler, Router } from "express";
import type { AppPrismaClient } from "../infrastructure/database/prisma.js";
import {
  AuthController,
  AuthService,
  createAuthRouter,
  DEFAULT_AUTH_LOGIN_ACCOUNT_RATE_LIMIT,
  DEFAULT_AUTH_LOGIN_IP_RATE_LIMIT,
  DEFAULT_AUTH_REGISTER_RATE_LIMIT,
  loginAccountRateLimitKey,
  UserRepository,
  type JwtConfig,
} from "../modules/auth/index.js";
import { createAuthMiddleware } from "../middlewares/auth.middleware.js";
import {
  createRateLimitMiddleware,
  DEFAULT_PUBLIC_READ_RATE_LIMIT,
  type RateLimitConfig,
  type RateLimitKeyResolver,
} from "../middlewares/rate-limit.middleware.js";
import {
  createRecipeRouter,
  RecipeController,
  RecipeRepository,
  RecipeService,
} from "../modules/recipes/index.js";
import type { ReadinessDatabaseClient } from "../shared/http/health.router.js";
import {
  createUserAdminRouter,
  UserAdminController,
  UserAdminRepository,
  UserAdminService,
} from "../modules/users/index.js";

export type { JwtConfig } from "../modules/auth/index.js";

export type MountedRouter = Readonly<{
  path: string;
  router: Router;
}>;

/**
 * Rate limits de `/api/v1/auth` (#39). Cada entrada acepta una configuración propia o `false`
 * para desactivarla; `false` en el conjunto las desactiva todas (solo pruebas que no las ejercitan).
 */
export type AuthRateLimitOptions = Readonly<{
  login?: RateLimitConfig | false | undefined;
  loginAccount?: RateLimitConfig | false | undefined;
  register?: RateLimitConfig | false | undefined;
}>;

export type BuildApiRoutersOptions = Readonly<{
  jwt?: JwtConfig | undefined;
  /** Rate limit del catálogo público; `false` lo desactiva (solo pruebas que no lo ejercitan). */
  publicRateLimit?: RateLimitConfig | false | undefined;
  authRateLimit?: AuthRateLimitOptions | false | undefined;
}>;

function buildOptionalLimiter(
  config: RateLimitConfig | false | undefined,
  defaults: RateLimitConfig,
  key?: RateLimitKeyResolver,
): RequestHandler | undefined {
  if (config === false) {
    return undefined;
  }
  return createRateLimitMiddleware(config ?? defaults, key === undefined ? undefined : { key });
}

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
  const authRateLimit = options?.authRateLimit === false ? undefined : (options?.authRateLimit ?? {});
  const loginLimiters =
    authRateLimit === undefined
      ? []
      : [
          buildOptionalLimiter(authRateLimit.login, DEFAULT_AUTH_LOGIN_IP_RATE_LIMIT),
          buildOptionalLimiter(
            authRateLimit.loginAccount,
            DEFAULT_AUTH_LOGIN_ACCOUNT_RATE_LIMIT,
            loginAccountRateLimitKey,
          ),
        ].filter((limiter): limiter is RequestHandler => limiter !== undefined);
  const registerLimiter =
    authRateLimit === undefined
      ? undefined
      : buildOptionalLimiter(authRateLimit.register, DEFAULT_AUTH_REGISTER_RATE_LIMIT);
  const authRouter = createAuthRouter(authController, { loginLimiters, registerLimiter });

  // Guarda JWT con DI explícita: sin `jwt` falla cerrado (500 redactado) en cada request protegida.
  const authGuard = createAuthMiddleware({ secret: options?.jwt?.secret });

  const recipeRepository = new RecipeRepository(prisma);
  const recipeService = new RecipeService(recipeRepository);
  const recipeController = new RecipeController(recipeService);
  const publicRateLimit = options?.publicRateLimit ?? DEFAULT_PUBLIC_READ_RATE_LIMIT;
  const publicReadLimiter =
    publicRateLimit === false ? undefined : createRateLimitMiddleware(publicRateLimit);
  const recipeRouter = createRecipeRouter(recipeController, authGuard, { publicReadLimiter });

  const userAdminService = new UserAdminService(new UserAdminRepository(prisma));
  const userAdminRouter = createUserAdminRouter(new UserAdminController(userAdminService), authGuard);

  return [
    { path: "/auth", router: authRouter },
    { path: "/recipes", router: recipeRouter },
    { path: "/users", router: userAdminRouter },
  ];
}
