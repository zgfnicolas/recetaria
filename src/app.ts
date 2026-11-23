import cors, { type CorsOptions } from "cors";
import express, { type Express } from "express";
import {
  buildApiRouters,
  isAppPrismaClient,
  type AuthRateLimitOptions,
  type JwtConfig,
  type MountedRouter,
} from "./bootstrap/container.js";
import type { AppPrismaClient } from "./infrastructure/database/prisma.js";
import { createErrorHandlerMiddleware, type ErrorLogger } from "./middlewares/error-handler.middleware.js";
import { createLoggerMiddleware, type LogWriter } from "./middlewares/logger.middleware.js";
import {
  RATE_LIMIT_EXPOSED_HEADERS,
  type RateLimitConfig,
} from "./middlewares/rate-limit.middleware.js";
import { notFoundMiddleware } from "./middlewares/not-found.middleware.js";
import { createHealthRouter, type ReadinessDatabaseClient } from "./shared/http/health.router.js";

export type { MountedRouter } from "./bootstrap/container.js";

export const BODY_LIMIT = "100kb";
export const API_V1_PREFIX = "/api/v1";

const DEFAULT_CORS_METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS"] as const;
const DEFAULT_CORS_ALLOWED_HEADERS = ["Content-Type", "Authorization"] as const;

function createDefaultCorsOptions(): CorsOptions {
  return {
    origin: "*",
    methods: [...DEFAULT_CORS_METHODS],
    allowedHeaders: [...DEFAULT_CORS_ALLOWED_HEADERS],
    exposedHeaders: [...RATE_LIMIT_EXPOSED_HEADERS],
    credentials: false,
  };
}

export const DEFAULT_CORS_OPTIONS: Readonly<CorsOptions> = Object.freeze(createDefaultCorsOptions());

export type BuildAppOptions = Readonly<{
  prisma?: AppPrismaClient | ReadinessDatabaseClient | undefined;
  readinessTimeoutMs?: number | undefined;
  jwt?: JwtConfig | undefined;
  /** Rate limit del catálogo público (default 120 req/min por IP); `false` lo desactiva. */
  publicRateLimit?: RateLimitConfig | false | undefined;
  /** Rate limits de `/api/v1/auth` (login por IP y por cuenta, registro); `false` los desactiva. */
  authRateLimit?: AuthRateLimitOptions | false | undefined;
  apiRouters?: readonly MountedRouter[] | undefined;
  cors?: CorsOptions | undefined;
  trustProxy?: boolean | number | string | undefined;
  onLog?: LogWriter | undefined;
  onError?: ErrorLogger | undefined;
}>;

/**
 * Fábrica de la aplicación Express 5 (sin abrir puerto TCP / `listen()`).
 * Configura endurecimiento HTTP, orden estricto de middlewares, parsers acotados,
 * montaje bajo `/api/v1`, `notFoundMiddleware` y `errorHandlerMiddleware`.
 */
export function buildApp(options?: BuildAppOptions): Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("query parser", "simple");
  app.set("trust proxy", options?.trustProxy ?? false);

  // 1. Logging HTTP seguro
  app.use(createLoggerMiddleware(options?.onLog));

  // 2. CORS explícito (clona arreglos por instancia para evitar mutación compartida)
  app.use(cors(options?.cors ?? createDefaultCorsOptions()));

  // 3. Sondas operativas de salud (antes de parsers y autenticación)
  app.use(
    createHealthRouter({
      prisma: options?.prisma,
      readinessTimeoutMs: options?.readinessTimeoutMs,
    }),
  );

  // 4. Parsers con límite de tamaño (OWASP API4)
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: BODY_LIMIT }));

  // 5. Routers de negocio versionados bajo /api/v1
  const apiV1Router = express.Router();
  const mountedRouters =
    options?.apiRouters ??
    (isAppPrismaClient(options?.prisma)
      ? buildApiRouters(options.prisma, {
          jwt: options?.jwt,
          publicRateLimit: options?.publicRateLimit,
          authRateLimit: options?.authRateLimit,
        })
      : []);

  for (const mounted of mountedRouters) {
    if (!mounted.path.startsWith("/")) {
      throw new RangeError(`La ruta del router debe comenzar con '/': ${mounted.path}`);
    }
    apiV1Router.use(mounted.path, mounted.router);
  }
  app.use(API_V1_PREFIX, apiV1Router);

  // 6. Manejo de rutas inexistentes (404) y traductor global de errores JSend
  app.use(notFoundMiddleware);
  app.use(createErrorHandlerMiddleware(options?.onError));

  return app;
}
