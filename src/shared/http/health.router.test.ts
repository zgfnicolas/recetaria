import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { createHealthRouter, type ReadinessDatabaseClient } from "./health.router.js";

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

describe("createHealthRouter (/health y /health/ready)", () => {
  it("GET /health responde 200 JSend con Cache-Control no-store y sin consultar Prisma aunque falle", async () => {
    // Arrange
    const queryRaw = vi.fn().mockRejectedValue(new Error("PG_INTERNAL_FAILURE"));
    const app = buildApp({
      prisma: { $queryRaw: queryRaw },
      onLog: vi.fn(),
      onError: vi.fn(),
    });

    // Act
    const res = await request(app).get("/health");

    // Assert
    expect(res.status).toBe(200);
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(queryRaw).not.toHaveBeenCalled();
    expect(res.body).toEqual({
      success: true,
      statusCode: 200,
      message: "Servicio operativo",
      data: {
        status: "ok",
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      },
    });
  });

  it("GET /health y GET /health/ready se montan antes de parsers JSON (responden 200 ante JSON malformado o > 100kb; rutas posteriores responden 400)", async () => {
    // Arrange
    const queryRaw = vi.fn().mockResolvedValue([{ "?column?": 1 }]);
    const app = buildApp({ prisma: { $queryRaw: queryRaw }, onLog: vi.fn(), onError: vi.fn() });
    const oversizedPayload = `{"padding":"${"a".repeat(120_000)}"}`;

    // Act
    const healthMalformed = await request(app)
      .get("/health")
      .set("Content-Type", "application/json")
      .send('{"json": roto');
    const healthOversized = await request(app)
      .get("/health")
      .set("Content-Type", "application/json")
      .send(oversizedPayload);
    const readyMalformed = await request(app)
      .get("/health/ready")
      .set("Content-Type", "application/json")
      .send('{"json": roto');
    const readyOversized = await request(app)
      .get("/health/ready")
      .set("Content-Type", "application/json")
      .send(oversizedPayload);
    const apiMalformed = await request(app)
      .get("/api/v1/no-existe")
      .set("Content-Type", "application/json")
      .send('{"json": roto');

    // Assert
    for (const res of [healthMalformed, healthOversized]) {
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("ok");
    }
    for (const res of [readyMalformed, readyOversized]) {
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("ready");
      expect(res.body.data.database).toBe("up");
    }
    expect(apiMalformed.status).toBe(400);
    expect(apiMalformed.body).toEqual({
      success: false,
      statusCode: 400,
      message: "JSON inválido en el cuerpo de la solicitud",
      errors: [],
    });
  });

  it("GET /health/ready responde 503 JSend cuando no se inyectó cliente Prisma", async () => {
    // Arrange
    const onError = vi.fn();
    const app = buildApp({ onLog: vi.fn(), onError });

    // Act
    const res = await request(app).get("/health/ready");

    // Assert
    expect(onError).not.toHaveBeenCalled();
    expect(res.status).toBe(503);
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({
      success: false,
      statusCode: 503,
      message: "Base de datos no disponible",
      errors: [],
    });
  });

  it("GET /health/ready ejecuta SELECT 1 y responde 200 JSend cuando Prisma responde a tiempo", async () => {
    // Arrange
    const queryRaw = vi.fn().mockResolvedValue([{ "?column?": 1 }]);
    const app = buildApp({
      prisma: { $queryRaw: queryRaw },
      onLog: vi.fn(),
      onError: vi.fn(),
    });

    // Act
    const res = await request(app).get("/health/ready");

    // Assert
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const firstTemplateArg = queryRaw.mock.calls[0]?.[0];
    expect(Array.isArray(firstTemplateArg)).toBe(true);
    expect(firstTemplateArg?.[0]).toBe("SELECT 1");
    expect(res.body).toEqual({
      success: true,
      statusCode: 200,
      message: "Servicio listo",
      data: {
        status: "ready",
        database: "up",
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      },
    });
  });

  it.each([
    {
      label: "rechazo asíncrono",
      prisma: {
        $queryRaw: () => Promise.reject(new Error("PG_SECRET_HOST=10.0.0.1")),
      } satisfies ReadinessDatabaseClient,
      secretMarker: "PG_SECRET_HOST",
    },
    {
      label: "excepción síncrona",
      prisma: {
        $queryRaw: () => {
          throw new Error("SYNC_DB_BOOM");
        },
      } satisfies ReadinessDatabaseClient,
      secretMarker: "SYNC_DB_BOOM",
    },
  ])(
    "GET /health/ready responde 503 JSend redactado ante $label sin exponer detalles ni disparar onError",
    async ({ prisma, secretMarker }) => {
      // Arrange
      const onError = vi.fn();
      const app = buildApp({
        prisma,
        onLog: vi.fn(),
        onError,
      });

      // Act
      const res = await request(app).get("/health/ready");

      // Assert
      expect(onError).not.toHaveBeenCalled();
      expect(res.status).toBe(503);
      expect(res.headers["x-powered-by"]).toBeUndefined();
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toEqual({
        success: false,
        statusCode: 503,
        message: "Base de datos no disponible",
        errors: [],
      });
      expect(res.text).not.toContain(secretMarker);
    },
  );

  it("GET /health/ready aplica coalescencia single-flight ante ráfagas concurrentes (éxito, rechazo y recuperación)", async () => {
    // Arrange
    const firstQuery = createDeferred<readonly unknown[]>();
    const secondQuery = createDeferred<readonly unknown[]>();
    const queryRaw = vi
      .fn()
      .mockImplementationOnce(() => firstQuery.promise)
      .mockImplementationOnce(() => secondQuery.promise)
      .mockResolvedValueOnce([{ "?column?": 1 }]);
    const onError = vi.fn();
    const app = buildApp({
      prisma: { $queryRaw: queryRaw },
      onLog: vi.fn(),
      onError,
    });

    // Act 1: 5 consultas concurrentes exitosas comparten 1 invocación SQL
    const burstSuccess = Promise.all(
      Array.from({ length: 5 }, () => request(app).get("/health/ready")),
    );
    await vi.waitFor(() => {
      expect(queryRaw).toHaveBeenCalledTimes(1);
    });
    firstQuery.resolve([{ "?column?": 1 }]);
    const successResponses = await burstSuccess;

    for (const res of successResponses) {
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("ready");
      expect(res.body.data.database).toBe("up");
    }

    // Act 2: nueva ráfaga concurrente tras completarse la anterior emite una 2ª consulta única y comparte rechazo
    const burstFailure = Promise.all(
      Array.from({ length: 4 }, () => request(app).get("/health/ready")),
    );
    await vi.waitFor(() => {
      expect(queryRaw).toHaveBeenCalledTimes(2);
    });
    secondQuery.reject(new Error("POOL_SATURATED_SECRET"));
    const failureResponses = await burstFailure;

    for (const res of failureResponses) {
      expect(res.status).toBe(503);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.text).not.toContain("POOL_SATURATED_SECRET");
    }

    // Act 3: tras fallar el single-flight anterior, una nueva petición vuelve a consultar y se recupera
    const recovered = await request(app).get("/health/ready");
    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(recovered.status).toBe(200);
    expect(onError).not.toHaveBeenCalled();
  });

  it("GET /health/ready aborta por readinessTimeoutMs sin provocar UnhandledPromiseRejection", async () => {
    // Arrange
    const unhandledRejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const onError = vi.fn();

    const app = buildApp({
      prisma: {
        $queryRaw: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error("LATE_DB_ERROR")), 60);
          }),
      },
      readinessTimeoutMs: 25,
      onLog: vi.fn(),
      onError,
    });

    try {
      // Act
      const res = await request(app).get("/health/ready");
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 85);
      });

      // Assert
      expect(onError).not.toHaveBeenCalled();
      expect(res.status).toBe(503);
      expect(res.headers["x-powered-by"]).toBeUndefined();
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toEqual({
        success: false,
        statusCode: 503,
        message: "Base de datos no disponible",
        errors: [],
      });
      expect(res.text).not.toContain("Timeout de readiness");
      expect(res.text).not.toContain("LATE_DB_ERROR");
      expect(unhandledRejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "createHealthRouter rechaza readinessTimeoutMs inválido (%s)",
    (invalidTimeout) => {
      // Act & Assert
      expect(() => createHealthRouter({ readinessTimeoutMs: invalidTimeout })).toThrow(RangeError);
    },
  );
});
