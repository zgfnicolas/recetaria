import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { loadEnv, type Env } from "./config/env.js";
import { disconnect, getDatabase } from "./infrastructure/database/prisma.js";
import type { ErrorLogger } from "./middlewares/error-handler.middleware.js";
import type { LogWriter } from "./middlewares/logger.middleware.js";
import type { ReadinessDatabaseClient } from "./shared/http/health.router.js";

/** Timeouts HTTP defensivos para proxies/load balancers y mitigación de Slowloris. */
export const SERVER_KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const SERVER_HEADERS_TIMEOUT_MS = 66_000;
export const SERVER_REQUEST_TIMEOUT_MS = 30_000;

/** Ventana máxima de drenaje en apagado ordenado (< stop_grace_period: 30s de compose.yaml). */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

export type ShutdownReason =
  | "SIGTERM"
  | "SIGINT"
  | "uncaughtException"
  | "unhandledRejection"
  | "serverError";

export type ClosableServer = Readonly<{
  close: (callback: (err?: Error) => void) => void;
  closeIdleConnections?: (() => void) | undefined;
  closeAllConnections?: (() => void) | undefined;
}>;

export type ServerDatabase = Readonly<{
  prisma: ReadinessDatabaseClient;
  disconnect: () => Promise<void>;
}>;

export type GracefulShutdownOptions = Readonly<{
  server: ClosableServer;
  closeDatabase: () => Promise<void>;
  onLog?: LogWriter | undefined;
  onError?: ErrorLogger | undefined;
  exit?: ((code: number) => void) | undefined;
  timeoutMs?: number | undefined;
}>;

export type StartServerOptions = Readonly<{
  env?: Env | undefined;
  database?: ServerDatabase | undefined;
  port?: number | undefined;
  registerSignals?: boolean | undefined;
  shutdownTimeoutMs?: number | undefined;
  onLog?: LogWriter | undefined;
  onError?: ErrorLogger | undefined;
  exit?: ((code: number) => void) | undefined;
}>;

export type RunningServer = Readonly<{
  server: http.Server;
  shutdown: (reason: ShutdownReason, fatalError?: unknown) => Promise<void>;
  disposeListeners: () => void;
}>;

/**
 * Configura timeouts defensivos en `http.Server` (`headersTimeout > keepAliveTimeout`).
 */
export function applyServerTimeouts(server: http.Server): void {
  server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
  server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
}

function isServerNotRunningError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === "ERR_SERVER_NOT_RUNNING"
  );
}

function closeHttpServer(server: ClosableServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err !== undefined && !isServerNotRunningError(err)) {
        reject(err);
        return;
      }
      resolve();
    });
    server.closeIdleConnections?.();
  });
}

function createDrainingHttpServer(handler: http.RequestListener): {
  readonly server: http.Server;
  readonly closableServer: ClosableServer;
} {
  const activeResponses = new Set<http.ServerResponse>();
  let isShuttingDown = false;

  const server = http.createServer((req, res) => {
    if (isShuttingDown && !res.headersSent) {
      res.setHeader("Connection", "close");
    }

    activeResponses.add(res);
    const onResponseDone = (): void => {
      res.off("finish", onResponseDone);
      res.off("close", onResponseDone);
      activeResponses.delete(res);
      if (isShuttingDown) {
        server.closeIdleConnections();
      }
    };
    res.once("finish", onResponseDone);
    res.once("close", onResponseDone);

    handler(req, res);
  });

  const closableServer: ClosableServer = {
    close: (callback) => {
      isShuttingDown = true;
      for (const res of activeResponses) {
        if (!res.headersSent) {
          res.setHeader("Connection", "close");
        }
      }
      server.close(callback);
    },
    closeIdleConnections: () => {
      server.closeIdleConnections();
    },
    closeAllConnections: () => {
      server.closeAllConnections();
    },
  };

  return { server, closableServer };
}

/**
 * Construye un manejador idempotente de apagado ordenado:
 * deja de aceptar conexiones, drena peticiones activas, cierra Prisma + `pg.Pool`
 * y termina el proceso dentro del presupuesto de `SHUTDOWN_TIMEOUT_MS`.
 */
export function createGracefulShutdown(
  options: GracefulShutdownOptions,
): (reason: ShutdownReason, fatalError?: unknown) => Promise<void> {
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError(`timeoutMs inválido para shutdown: ${String(timeoutMs)}`);
  }

  const onLog = options.onLog ?? console.log;
  const onError = options.onError ?? console.error;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  let shutdownPromise: Promise<void> | undefined;
  let hasFatalError = false;

  return (reason: ShutdownReason, fatalError?: unknown): Promise<void> => {
    if (fatalError !== undefined) {
      hasFatalError = true;
      onError(`[SHUTDOWN:${reason}] Error fatal detectado`, fatalError);
    }

    if (shutdownPromise !== undefined) {
      return shutdownPromise;
    }

    if (fatalError === undefined) {
      onLog(`[SHUTDOWN:${reason}] Cerrando servidor HTTP y conexiones de base de datos...`);
    }

    shutdownPromise = (async (): Promise<void> => {
      let timedOut = false;
      let hasError = false;

      const forceTimer = setTimeout(() => {
        timedOut = true;
        onError(
          `[SHUTDOWN:${reason}] Timeout de ${String(timeoutMs)}ms superado; salida forzada`,
          undefined,
        );
        options.server.closeAllConnections?.();
        exit(1);
      }, timeoutMs);
      forceTimer.unref();

      try {
        try {
          await closeHttpServer(options.server);
        } catch (serverErr: unknown) {
          hasError = true;
          onError("[SHUTDOWN_SERVER_ERROR] Fallo al cerrar http.Server", serverErr);
        } finally {
          try {
            await options.closeDatabase();
          } catch (dbErr: unknown) {
            hasError = true;
            onError("[SHUTDOWN_DB_ERROR] Fallo al cerrar base de datos", dbErr);
          }
        }
      } finally {
        clearTimeout(forceTimer);
      }

      if (!timedOut) {
        exit(hasError || hasFatalError ? 1 : 0);
      }
    })();

    return shutdownPromise;
  };
}

/**
 * Carga la configuración validada, enlaza el cliente Prisma singleton con `buildApp`,
 * inicia `http.Server` con timeouts defensivos y registra señales de apagado ordenado.
 */
export function startServer(options?: StartServerOptions): RunningServer {
  const onLog = options?.onLog ?? console.log;
  const onError = options?.onError ?? console.error;
  const env = options?.env ?? loadEnv();
  const usesDefaultDatabase = options?.database === undefined;
  const db = options?.database ?? getDatabase(env.DATABASE_URL);
  const port = options?.port ?? env.PORT;

  const app = buildApp({
    prisma: db.prisma,
    onLog,
    onError,
  });

  const { server, closableServer } = createDrainingHttpServer(app);
  applyServerTimeouts(server);

  const shutdown = createGracefulShutdown({
    server: closableServer,
    closeDatabase: usesDefaultDatabase ? () => disconnect() : () => db.disconnect(),
    onLog,
    onError,
    exit: options?.exit,
    timeoutMs: options?.shutdownTimeoutMs,
  });

  const onSigTerm = (): void => {
    void shutdown("SIGTERM");
  };
  const onSigInt = (): void => {
    void shutdown("SIGINT");
  };
  const onUncaughtException = (err: unknown): void => {
    void shutdown("uncaughtException", err);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    void shutdown("unhandledRejection", reason);
  };
  const onServerError = (err: Error): void => {
    void shutdown("serverError", err);
  };

  server.on("error", onServerError);

  const registerSignals = options?.registerSignals ?? true;
  if (registerSignals) {
    process.once("SIGTERM", onSigTerm);
    process.once("SIGINT", onSigInt);
    process.on("uncaughtException", onUncaughtException);
    process.on("unhandledRejection", onUnhandledRejection);
  }

  const disposeListeners = (): void => {
    server.off("error", onServerError);
    if (registerSignals) {
      process.off("SIGTERM", onSigTerm);
      process.off("SIGINT", onSigInt);
      process.off("uncaughtException", onUncaughtException);
      process.off("unhandledRejection", onUnhandledRejection);
    }
  };

  server.listen(port, () => {
    const address = server.address();
    const boundPort = typeof address === "object" && address !== null ? address.port : port;
    onLog(`[SERVER] Recetaria API escuchando en puerto ${String(boundPort)} (${env.NODE_ENV})`);
  });

  return { server, shutdown, disposeListeners };
}

function isMainModule(): boolean {
  const entryArg = process.argv[1];
  if (entryArg === undefined) {
    return false;
  }
  return path.resolve(entryArg) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    startServer();
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Error desconocido al iniciar el servidor";
    console.error(`[SERVER_STARTUP_ERROR] ${message}`);
    process.exit(1);
  }
}
