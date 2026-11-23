import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "./config/env.js";
import {
  applyServerTimeouts,
  createGracefulShutdown,
  startServer,
  type ClosableServer,
  type ServerDatabase,
} from "./server.js";

const execFileAsync = promisify(execFile);

const TEST_ENV: Env = Object.freeze({
  NODE_ENV: "test",
  PORT: 0,
  DATABASE_URL: "postgresql://recetaria:devpass@localhost:5433/recetaria",
  JWT_SECRET: "s".repeat(32),
  JWT_EXPIRES_IN: "1d",
  TRUST_PROXY: 0,
});

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

async function waitForListeningPort(server: http.Server): Promise<number> {
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      const onError = (err: Error): void => {
        server.off("listening", onListening);
        reject(err);
      };
      server.once("listening", onListening);
      server.once("error", onError);
    });
  }

  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("El servidor no expuso un puerto TCP");
  }
  return address.port;
}

describe("applyServerTimeouts", () => {
  it("configura timeouts defensivos exactos (65s keepAlive, 66s headers > keepAlive, 30s request)", () => {
    // Arrange
    const server = http.createServer();

    // Act
    applyServerTimeouts(server);

    // Assert (oráculos literales independientes de constantes exportadas)
    expect(server.keepAliveTimeout).toBe(65_000);
    expect(server.headersTimeout).toBe(66_000);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
    expect(server.requestTimeout).toBe(30_000);
  });
});

describe("createGracefulShutdown", () => {
  it("ejecuta en orden estricto closeIdleConnections + server.close -> closeDatabase -> exit(0)", async () => {
    // Arrange
    const events: string[] = [];
    const server: ClosableServer = {
      closeIdleConnections: () => {
        events.push("closeIdleConnections");
      },
      close: (cb) => {
        setTimeout(() => {
          events.push("server.close");
          cb();
        }, 10);
      },
    };
    const shutdown = createGracefulShutdown({
      server,
      closeDatabase: async () => {
        events.push("closeDatabase");
      },
      onLog: vi.fn(),
      onError: vi.fn(),
      exit: (code) => {
        events.push(`exit:${String(code)}`);
      },
    });

    // Act
    await shutdown("SIGTERM");

    // Assert
    expect(events).toEqual([
      "closeIdleConnections",
      "server.close",
      "closeDatabase",
      "exit:0",
    ]);
  });

  it("es idempotente ante señales concurrentes y devuelve la misma promesa", async () => {
    // Arrange
    const closeSpy = vi.fn((cb: (err?: Error) => void) => {
      setTimeout(() => cb(), 15);
    });
    const closeDbSpy = vi.fn().mockResolvedValue(undefined);
    const exitSpy = vi.fn();
    const shutdown = createGracefulShutdown({
      server: { close: closeSpy },
      closeDatabase: closeDbSpy,
      onLog: vi.fn(),
      onError: vi.fn(),
      exit: exitSpy,
    });

    // Act
    const first = shutdown("SIGTERM");
    const second = shutdown("SIGINT");
    await Promise.all([first, second]);

    // Assert
    expect(second).toBe(first);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeDbSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("tolera ERR_SERVER_NOT_RUNNING al cerrar server y ejecuta igualmente closeDatabase con exit(0)", async () => {
    // Arrange
    const onError = vi.fn();
    const closeDbSpy = vi.fn().mockResolvedValue(undefined);
    const exitSpy = vi.fn();
    const notRunningErr = Object.assign(new Error("Server is not running"), {
      code: "ERR_SERVER_NOT_RUNNING",
    });
    const shutdown = createGracefulShutdown({
      server: {
        close: (cb) => cb(notRunningErr),
      },
      closeDatabase: closeDbSpy,
      onLog: vi.fn(),
      onError,
      exit: exitSpy,
    });

    // Act
    await shutdown("SIGINT");

    // Assert
    expect(onError).not.toHaveBeenCalled();
    expect(closeDbSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("cierra DB, registra prefijos exactos y sale con código 1 ante fatalError, error en server/DB o fallo simultáneo", async () => {
    // Arrange
    const fatalOnError = vi.fn();
    const fatalCloseDb = vi.fn().mockResolvedValue(undefined);
    const fatalExit = vi.fn();
    const fatalShutdown = createGracefulShutdown({
      server: { close: (cb) => cb() },
      closeDatabase: fatalCloseDb,
      onLog: vi.fn(),
      onError: fatalOnError,
      exit: fatalExit,
    });

    const serverErrOnError = vi.fn();
    const serverErrCloseDb = vi.fn().mockResolvedValue(undefined);
    const serverErrExit = vi.fn();
    const serverErrShutdown = createGracefulShutdown({
      server: { close: (cb) => cb(new Error("close failed")) },
      closeDatabase: serverErrCloseDb,
      onLog: vi.fn(),
      onError: serverErrOnError,
      exit: serverErrExit,
    });

    const dbErrOnError = vi.fn();
    const dbErrExit = vi.fn();
    const dbErrShutdown = createGracefulShutdown({
      server: { close: (cb) => cb() },
      closeDatabase: async () => {
        throw new Error("disconnect failed");
      },
      onLog: vi.fn(),
      onError: dbErrOnError,
      exit: dbErrExit,
    });

    const bothOnError = vi.fn();
    const bothExit = vi.fn();
    const bothErrShutdown = createGracefulShutdown({
      server: { close: (cb) => cb(new Error("close failed")) },
      closeDatabase: async () => {
        throw new Error("disconnect failed");
      },
      onLog: vi.fn(),
      onError: bothOnError,
      exit: bothExit,
    });

    // Act
    const boom = new Error("boom");
    await fatalShutdown("uncaughtException", boom);
    await serverErrShutdown("SIGTERM");
    await dbErrShutdown("SIGTERM");
    await bothErrShutdown("SIGTERM");

    // Assert
    expect(fatalOnError).toHaveBeenCalledTimes(1);
    expect(fatalOnError).toHaveBeenCalledWith(
      "[SHUTDOWN:uncaughtException] Error fatal detectado",
      boom,
    );
    expect(fatalCloseDb).toHaveBeenCalledTimes(1);
    expect(fatalExit).toHaveBeenCalledWith(1);

    expect(serverErrOnError).toHaveBeenCalledTimes(1);
    expect(String(serverErrOnError.mock.calls[0]?.[0])).toContain("[SHUTDOWN_SERVER_ERROR]");
    expect(serverErrCloseDb).toHaveBeenCalledTimes(1);
    expect(serverErrExit).toHaveBeenCalledWith(1);

    expect(dbErrOnError).toHaveBeenCalledTimes(1);
    expect(String(dbErrOnError.mock.calls[0]?.[0])).toContain("[SHUTDOWN_DB_ERROR]");
    expect(dbErrExit).toHaveBeenCalledWith(1);

    expect(bothOnError).toHaveBeenCalledTimes(2);
    expect(String(bothOnError.mock.calls[0]?.[0])).toContain("[SHUTDOWN_SERVER_ERROR]");
    expect(String(bothOnError.mock.calls[1]?.[0])).toContain("[SHUTDOWN_DB_ERROR]");
    expect(bothExit).toHaveBeenCalledTimes(1);
    expect(bothExit).toHaveBeenCalledWith(1);
  });

  it("registra fatalError y sale con código 1 cuando ocurre un fallo fatal durante un apagado ya iniciado", async () => {
    // Arrange
    let pendingCallback: ((err?: Error) => void) | undefined;
    const onError = vi.fn();
    const closeDbSpy = vi.fn().mockResolvedValue(undefined);
    const exitSpy = vi.fn();
    const shutdown = createGracefulShutdown({
      server: {
        close: (cb) => {
          pendingCallback = cb;
        },
      },
      closeDatabase: closeDbSpy,
      onLog: vi.fn(),
      onError,
      exit: exitSpy,
    });

    // Act
    const first = shutdown("SIGTERM");
    const midDrainBoom = new Error("mid-drain boom");
    const second = shutdown("uncaughtException", midDrainBoom);
    pendingCallback?.();
    await first;

    // Assert
    expect(second).toBe(first);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      "[SHUTDOWN:uncaughtException] Error fatal detectado",
      midDrainBoom,
    );
    expect(closeDbSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("fuerza exit(1) sin doble salida cuando server.close supera timeoutMs (fake timers)", async () => {
    // Arrange
    vi.useFakeTimers();
    try {
      let pendingCallback: ((err?: Error) => void) | undefined;
      const onError = vi.fn();
      const closeDbSpy = vi.fn().mockResolvedValue(undefined);
      const closeAllSpy = vi.fn();
      const exitSpy = vi.fn();
      const shutdown = createGracefulShutdown({
        server: {
          close: (cb) => {
            pendingCallback = cb;
          },
          closeAllConnections: closeAllSpy,
        },
        closeDatabase: closeDbSpy,
        onLog: vi.fn(),
        onError,
        exit: exitSpy,
        timeoutMs: 25,
      });

      // Act
      const shutdownPromise = shutdown("SIGTERM");
      await vi.advanceTimersByTimeAsync(25);

      expect(onError).toHaveBeenCalledTimes(1);
      expect(String(onError.mock.calls[0]?.[0])).toContain("Timeout de 25ms superado");
      expect(closeAllSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(closeDbSpy).not.toHaveBeenCalled();

      pendingCallback?.();
      await shutdownPromise;

      // Assert
      expect(closeDbSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fuerza exit(1) sin doble salida cuando closeDatabase supera timeoutMs (fake timers)", async () => {
    // Arrange
    vi.useFakeTimers();
    try {
      const dbHang = createDeferred<void>();
      const onError = vi.fn();
      const closeAllSpy = vi.fn();
      const exitSpy = vi.fn();
      const shutdown = createGracefulShutdown({
        server: {
          close: (cb) => cb(),
          closeAllConnections: closeAllSpy,
        },
        closeDatabase: () => dbHang.promise,
        onLog: vi.fn(),
        onError,
        exit: exitSpy,
        timeoutMs: 25,
      });

      // Act
      const shutdownPromise = shutdown("SIGINT");
      await vi.advanceTimersByTimeAsync(25);

      expect(onError).toHaveBeenCalledTimes(1);
      expect(String(onError.mock.calls[0]?.[0])).toContain("Timeout de 25ms superado");
      expect(closeAllSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);

      dbHang.resolve();
      await shutdownPromise;

      // Assert
      expect(exitSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rechaza timeoutMs inválido con RangeError (%s)",
    (invalidTimeout) => {
      // Act & Assert
      expect(() =>
        createGracefulShutdown({
          server: { close: (cb) => cb() },
          closeDatabase: async () => undefined,
          timeoutMs: invalidTimeout,
        }),
      ).toThrow(RangeError);
    },
  );
});

describe("startServer (integración sobre puerto efímero y ciclo de vida)", () => {
  it("aplica timeouts defensivos, cierra socket keep-alive ocioso, rechaza nuevas conexiones y drena petición en curso al recibir SIGTERM", async () => {
    // Arrange
    const queryStarted = createDeferred<void>();
    const releaseQuery = createDeferred<void>();
    const idleSocketClosed = createDeferred<void>();
    const disconnectSpy = vi.fn().mockResolvedValue(undefined);
    const exitSpy = vi.fn();
    const logs: string[] = [];
    const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 2 });

    const stubDb: ServerDatabase = {
      prisma: {
        $queryRaw: async () => {
          queryStarted.resolve();
          await releaseQuery.promise;
          return [{ "?column?": 1 }];
        },
      },
      disconnect: disconnectSpy,
    };

    const running = startServer({
      env: TEST_ENV,
      database: stubDb,
      port: 0,
      registerSignals: false,
      onLog: (line) => logs.push(line),
      onError: vi.fn(),
      exit: exitSpy,
    });

    try {
      const boundPort = await waitForListeningPort(running.server);
      expect(running.server.keepAliveTimeout).toBe(65_000);
      expect(running.server.headersTimeout).toBe(66_000);
      expect(running.server.requestTimeout).toBe(30_000);

      const baseUrl = `http://127.0.0.1:${String(boundPort)}`;

      // Conexión keep-alive previa que queda ociosa en keepAliveAgent tras consumir GET /health
      const idleProbe = await new Promise<{ readonly statusCode: number }>((resolve, reject) => {
        const req = http.get(`${baseUrl}/health`, { agent: keepAliveAgent }, (res) => {
          res.socket.once("close", () => idleSocketClosed.resolve());
          res.resume();
          res.once("end", () => resolve({ statusCode: res.statusCode ?? 0 }));
        });
        req.once("error", reject);
      });
      expect(idleProbe.statusCode).toBe(200);

      // Petición readiness independiente retenida en curso antes de SIGTERM
      const inFlightReadiness = fetch(`${baseUrl}/health/ready`);
      await queryStarted.promise;

      // Act: inicia SIGTERM -> socket ocioso se cierra, nuevas conexiones rechazan, DB aún no desconecta
      const shutdownPromise = running.shutdown("SIGTERM");
      await idleSocketClosed.promise;
      await expect(fetch(`${baseUrl}/health`)).rejects.toThrow();

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25);
      });
      expect(disconnectSpy).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();

      releaseQuery.resolve();
      const [readyRes] = await Promise.all([inFlightReadiness, shutdownPromise]);
      const readyBody = (await readyRes.json()) as {
        readonly success: boolean;
        readonly statusCode: number;
      };

      // Assert
      expect(readyRes.status).toBe(200);
      expect(readyRes.headers.get("connection")).toBe("close");
      expect(readyBody.success).toBe(true);
      expect(running.server.listening).toBe(false);
      expect(disconnectSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(logs.some((line) => line.includes(`escuchando en puerto ${String(boundPort)}`))).toBe(
        true,
      );
    } finally {
      releaseQuery.resolve();
      keepAliveAgent.destroy();
      running.disposeListeners();
      running.server.closeAllConnections();
      if (running.server.listening) {
        await new Promise<void>((resolve) => {
          running.server.close(() => resolve());
          running.server.closeAllConnections();
        });
      }
    }
  });

  it("registra listeners de proceso por defecto y los remueve por completo con disposeListeners()", async () => {
    // Arrange
    const baseline = {
      SIGTERM: process.listenerCount("SIGTERM"),
      SIGINT: process.listenerCount("SIGINT"),
      uncaughtException: process.listenerCount("uncaughtException"),
      unhandledRejection: process.listenerCount("unhandledRejection"),
    };
    const stubDb: ServerDatabase = {
      prisma: { $queryRaw: async () => [{ "?column?": 1 }] },
      disconnect: vi.fn().mockResolvedValue(undefined),
    };

    // Act
    const running = startServer({
      env: TEST_ENV,
      database: stubDb,
      port: 0,
      onLog: vi.fn(),
      onError: vi.fn(),
      exit: vi.fn(),
    });

    try {
      await waitForListeningPort(running.server);
      expect(process.listenerCount("SIGTERM")).toBe(baseline.SIGTERM + 1);
      expect(process.listenerCount("SIGINT")).toBe(baseline.SIGINT + 1);
      expect(process.listenerCount("uncaughtException")).toBe(baseline.uncaughtException + 1);
      expect(process.listenerCount("unhandledRejection")).toBe(baseline.unhandledRejection + 1);
    } finally {
      running.disposeListeners();
      await running.shutdown("SIGTERM");
      running.server.closeAllConnections();
    }

    // Assert
    expect(process.listenerCount("SIGTERM")).toBe(baseline.SIGTERM);
    expect(process.listenerCount("SIGINT")).toBe(baseline.SIGINT);
    expect(process.listenerCount("uncaughtException")).toBe(baseline.uncaughtException);
    expect(process.listenerCount("unhandledRejection")).toBe(baseline.unhandledRejection);
  });

  it("maneja EADDRINUSE vía server.on('error'), desconecta Prisma y sale con código 1", async () => {
    // Arrange
    const blocker = http.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => resolve());
    });
    const occupiedPort = await waitForListeningPort(blocker);

    const exitDeferred = createDeferred<number>();
    const exitSpy = vi.fn((code: number) => {
      exitDeferred.resolve(code);
    });
    const onError = vi.fn();
    const disconnectSpy = vi.fn().mockResolvedValue(undefined);
    const stubDb: ServerDatabase = {
      prisma: { $queryRaw: async () => [{ "?column?": 1 }] },
      disconnect: disconnectSpy,
    };

    const running = startServer({
      env: TEST_ENV,
      database: stubDb,
      port: occupiedPort,
      registerSignals: false,
      onLog: vi.fn(),
      onError,
      exit: exitSpy,
    });

    try {
      // Act
      const code = await exitDeferred.promise;

      // Assert
      expect(code).toBe(1);
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(disconnectSpy).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(String(onError.mock.calls[0]?.[0])).toContain("[SHUTDOWN:serverError]");
    } finally {
      running.disposeListeners();
      running.server.closeAllConnections();
      await new Promise<void>((resolve) => {
        blocker.close(() => resolve());
        blocker.closeAllConnections();
      });
    }
  });

  it("corta conexiones colgadas con closeAllConnections() al vencer shutdownTimeoutMs sobre puerto efímero", async () => {
    // Arrange
    const queryStarted = createDeferred<void>();
    const releaseQuery = createDeferred<void>();
    const exitDeferred = createDeferred<number>();
    const disconnectSpy = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const exitSpy = vi.fn((code: number) => {
      exitDeferred.resolve(code);
    });

    const stubDb: ServerDatabase = {
      prisma: {
        $queryRaw: async () => {
          queryStarted.resolve();
          await releaseQuery.promise;
          return [{ "?column?": 1 }];
        },
      },
      disconnect: disconnectSpy,
    };

    const running = startServer({
      env: TEST_ENV,
      database: stubDb,
      port: 0,
      registerSignals: false,
      shutdownTimeoutMs: 35,
      onLog: vi.fn(),
      onError,
      exit: exitSpy,
    });

    try {
      const boundPort = await waitForListeningPort(running.server);
      const inFlightReadiness = fetch(`http://127.0.0.1:${String(boundPort)}/health/ready`);
      await queryStarted.promise;

      // Act
      const shutdownPromise = running.shutdown("SIGTERM");
      const exitCode = await exitDeferred.promise;

      // Assert
      await expect(inFlightReadiness).rejects.toThrow();
      expect(exitCode).toBe(1);
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(String(onError.mock.calls[0]?.[0])).toContain("Timeout de 35ms superado");

      releaseQuery.resolve();
      await shutdownPromise;
      expect(disconnectSpy).toHaveBeenCalledTimes(1);
    } finally {
      releaseQuery.resolve();
      running.disposeListeners();
      running.server.closeAllConnections();
      if (running.server.listening) {
        await new Promise<void>((resolve) => {
          running.server.close(() => resolve());
          running.server.closeAllConnections();
        });
      }
    }
  });

  it("isMainModule() permite importar src/server.ts sin efectos laterales y falla con exit(1) ante entorno inválido al ejecutarse directamente", async () => {
    // Arrange
    const isolatedEnv = {
      PATH: process.env["PATH"],
      DATABASE_URL: "http://secret-db-host.local/recetaria",
      JWT_SECRET: "TOP_SECRET_TOO_SHORT",
    };

    // Act 1: importación de módulo sin ser entrypoint
    const importResult = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        'import("./src/server.ts").then(() => console.log("IMPORTED_OK"))',
      ],
      { env: isolatedEnv },
    );

    // Assert 1
    expect(importResult.stdout.trim()).toBe("IMPORTED_OK");

    // Act 2: ejecución directa como entrypoint con variables inválidas
    let startupFailure: { readonly code?: unknown; readonly stderr?: unknown } | undefined;
    try {
      await execFileAsync(process.execPath, ["--import", "tsx", "src/server.ts"], {
        env: isolatedEnv,
      });
    } catch (err: unknown) {
      startupFailure = err as { readonly code?: unknown; readonly stderr?: unknown };
    }

    // Assert 2
    expect(startupFailure).toBeDefined();
    expect(startupFailure?.code).toBe(1);
    expect(String(startupFailure?.stderr ?? "")).toContain("[SERVER_STARTUP_ERROR]");
    expect(String(startupFailure?.stderr ?? "")).not.toContain("TOP_SECRET_TOO_SHORT");
    expect(String(startupFailure?.stderr ?? "")).not.toContain("secret-db-host.local");
  });
});
