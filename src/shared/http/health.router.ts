import express, { type Router } from "express";
import { ServiceUnavailableError } from "../errors/app-error.js";
import { sendSuccess } from "./jsend.js";

/** Timeout por defecto (ms) para la sonda readiness contra PostgreSQL (< HEALTHCHECK 3s). */
export const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

/** Contrato mínimo requerido por la sonda readiness (`SELECT 1`). */
export type ReadinessDatabaseClient = Readonly<{
  $queryRaw: (query: TemplateStringsArray, ...values: readonly unknown[]) => PromiseLike<unknown>;
}>;

export type HealthRouterOptions = Readonly<{
  prisma?: ReadinessDatabaseClient | undefined;
  readinessTimeoutMs?: number | undefined;
}>;

async function checkDatabaseReadiness(
  queryPromise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timeout de readiness (${String(timeoutMs)}ms)`));
    }, timeoutMs);
    timer.unref();
  });

  try {
    await Promise.race([queryPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Construye el router con sondas separadas de liveness (`/health`) y readiness (`/health/ready`),
 * pensado para montarse antes de parsers y autenticación (`ADR-0006`).
 */
export function createHealthRouter(options?: HealthRouterOptions): Router {
  const timeoutMs = options?.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError(`readinessTimeoutMs inválido: ${String(timeoutMs)}`);
  }

  let inFlightQuery: Promise<unknown> | undefined;

  const getOrStartReadinessQuery = (prisma: ReadinessDatabaseClient): Promise<unknown> => {
    if (inFlightQuery === undefined) {
      const queryPromise = Promise.resolve().then(() => prisma.$queryRaw`SELECT 1`);
      inFlightQuery = queryPromise;
      const clearInFlight = (): void => {
        if (inFlightQuery === queryPromise) {
          inFlightQuery = undefined;
        }
      };
      // Registra manejadores de éxito y rechazo para limpiar single-flight y evitar UnhandledPromiseRejection.
      void queryPromise.then(clearInFlight, clearInFlight);
    }
    return inFlightQuery;
  };

  const router = express.Router();

  router.get("/health", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    sendSuccess(res, {
      message: "Servicio operativo",
      data: {
        status: "ok",
        timestamp: new Date().toISOString(),
      },
    });
  });

  router.get("/health/ready", async (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");

    const prisma = options?.prisma;
    if (prisma === undefined) {
      next(new ServiceUnavailableError("Base de datos no disponible"));
      return;
    }

    try {
      await checkDatabaseReadiness(getOrStartReadinessQuery(prisma), timeoutMs);
      sendSuccess(res, {
        message: "Servicio listo",
        data: {
          status: "ready",
          database: "up",
          timestamp: new Date().toISOString(),
        },
      });
    } catch (err: unknown) {
      next(new ServiceUnavailableError("Base de datos no disponible", { cause: err }));
    }
  });

  return router;
}
