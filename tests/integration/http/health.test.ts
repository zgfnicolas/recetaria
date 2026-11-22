import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../src/app.js";
import {
  createDatabase,
  disconnect,
  getDatabase,
  type Database,
} from "../../../src/infrastructure/database/prisma.js";

describe("Sondas de salud HTTP — Integración contra PostgreSQL 15 en Docker", () => {
  let db: Database;

  beforeAll(() => {
    db = getDatabase();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("GET /health devuelve 200 JSend con PostgreSQL activo y aun cuando el cliente DB falla", async () => {
    // Arrange
    const healthyApp = buildApp({ prisma: db.prisma, onLog: vi.fn(), onError: vi.fn() });
    const failingApp = buildApp({
      prisma: { $queryRaw: () => Promise.reject(new Error("DB down")) },
      onLog: vi.fn(),
      onError: vi.fn(),
    });

    // Act
    const resHealthy = await request(healthyApp).get("/health");
    const resDegraded = await request(failingApp).get("/health");

    // Assert
    for (const res of [resHealthy, resDegraded]) {
      expect(res.status).toBe(200);
      expect(res.headers["x-powered-by"]).toBeUndefined();
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body).toEqual({
        success: true,
        statusCode: 200,
        message: "Servicio operativo",
        data: {
          status: "ok",
          timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        },
      });
    }
  });

  it("GET /health/ready devuelve 200 JSend ejecutando SELECT 1 real contra PostgreSQL 15", async () => {
    // Arrange
    const app = buildApp({ prisma: db.prisma, onLog: vi.fn(), onError: vi.fn() });

    // Act
    const res = await request(app).get("/health/ready");

    // Assert
    expect(res.status).toBe(200);
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["cache-control"]).toBe("no-store");
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

  it("GET /health/ready devuelve 503 JSend redactado cuando la consulta falla", async () => {
    // Arrange
    const onError = vi.fn();
    const app = buildApp({
      prisma: {
        $queryRaw: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5432")),
      },
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
    expect(res.text).not.toContain("ECONNREFUSED");
  });

  it("GET /health/ready devuelve 503 JSend redactado con createDatabase real apuntando a puerto inaccesible", async () => {
    // Arrange
    const unreachableDb = createDatabase(
      "postgresql://recetaria:SUPER_SECRET_PASS@127.0.0.1:1/recetaria",
    );
    const onError = vi.fn();
    const app = buildApp({
      prisma: unreachableDb.prisma,
      readinessTimeoutMs: 500,
      onLog: vi.fn(),
      onError,
    });

    try {
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
      expect(res.text).not.toContain("SUPER_SECRET_PASS");
      expect(res.text).not.toContain("127.0.0.1");
      expect(res.text).not.toContain("ECONNREFUSED");
      expect(res.text).not.toContain(":1");
    } finally {
      await unreachableDb.disconnect();
    }
  });

  it("GET /health/ready devuelve 503 JSend cuando excede readinessTimeoutMs", async () => {
    // Arrange
    let timer: NodeJS.Timeout | undefined;
    const app = buildApp({
      prisma: {
        $queryRaw: () =>
          new Promise((resolve) => {
            timer = setTimeout(() => resolve([{ "?column?": 1 }]), 100);
          }),
      },
      readinessTimeoutMs: 30,
      onLog: vi.fn(),
      onError: vi.fn(),
    });

    try {
      // Act
      const res = await request(app).get("/health/ready");

      // Assert
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
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  });
});
