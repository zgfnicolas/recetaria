import type express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../src/app.js";
import {
  disconnect,
  getDatabase,
  type Database,
} from "../../../src/infrastructure/database/prisma.js";
import { RATE_LIMIT_EXCEEDED_MESSAGE } from "../../../src/middlewares/rate-limit.middleware.js";
import type { JwtConfig } from "../../../src/modules/auth/index.js";

const TEST_JWT_CONFIG: JwtConfig = {
  secret: "test-jwt-secret-".repeat(3),
  expiresIn: "1h",
};

async function truncateTables(db: Database): Promise<void> {
  await db.prisma.$executeRaw`TRUNCATE TABLE "audit_logs", "recipes", "users" RESTART IDENTITY;`;
}

describe("Rate limit del catálogo público GET /api/v1/recipes (#36, OWASP API4)", () => {
  let db: Database;

  function createApp(options?: {
    readonly limit?: number;
    readonly disabled?: boolean;
    readonly trustProxy?: number;
  }): express.Express {
    return buildApp({
      prisma: db.prisma,
      jwt: TEST_JWT_CONFIG,
      publicRateLimit:
        options?.disabled === true
          ? false
          : options?.limit === undefined
            ? undefined
            : { windowMs: 60_000, limit: options.limit, identifier: "recipes-public-read" },
      trustProxy: options?.trustProxy,
      onLog: () => undefined,
      onError: () => undefined,
    });
  }

  async function exhaust(app: express.Express, times: number): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      const res = await request(app).get("/api/v1/recipes");
      expect(res.status).toBe(200);
    }
  }

  beforeAll(() => {
    db = getDatabase();
  });

  beforeEach(async () => {
    await truncateTables(db);
  });

  afterEach(async () => {
    await truncateTables(db);
  });

  afterAll(async () => {
    await disconnect();
  });

  it("aplica por defecto 120 solicitudes por minuto por IP (política recipes-public-read)", async () => {
    // Arrange
    const app = createApp();

    // Act
    const res = await request(app).get("/api/v1/recipes");

    // Assert
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-policy"]).toMatch(/^"recipes-public-read"; q=120; w=60; pk=:/);
    expect(res.headers["ratelimit"]).toMatch(/^"recipes-public-read"; r=119; t=\d+$/);
  });

  it("responde 429 JSend con Retry-After tras agotar la cuota, sin consultar la base", async () => {
    // Arrange
    const app = createApp({ limit: 3 });
    const findManySpy = vi.spyOn(db.prisma.recipe, "findMany");
    await exhaust(app, 3);

    // Act
    const res = await request(app).get("/api/v1/recipes?page=1&limit=20");

    // Assert
    expect(res.status).toBe(429);
    expect(findManySpy).toHaveBeenCalledTimes(3);
    expect(res.body).toEqual({
      success: false,
      statusCode: 429,
      message: RATE_LIMIT_EXCEEDED_MESSAGE,
      errors: [],
    });
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(res.headers["ratelimit"]).toMatch(/r=0;/);
  });

  it("cuenta también las solicitudes rechazadas con 400 (el limitador corre antes de validar la query)", async () => {
    // Arrange
    const app = createApp({ limit: 2 });

    // Act
    const invalid = await request(app).get("/api/v1/recipes?limit=999");
    const valid = await request(app).get("/api/v1/recipes");
    const blocked = await request(app).get("/api/v1/recipes");

    // Assert
    expect(invalid.status).toBe(400);
    expect(invalid.headers["ratelimit"]).toMatch(/r=1;/);
    expect(valid.status).toBe(200);
    expect(blocked.status).toBe(429);
  });

  it("no afecta a POST /api/v1/recipes, /api/v1/auth ni a las sondas /health tras agotar la cuota", async () => {
    // Arrange
    const app = createApp({ limit: 1 });
    await exhaust(app, 1);

    // Act
    const create = await request(app).post("/api/v1/recipes").send({});
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "nadie@recetaria.com", password: "x" });
    const health = await request(app).get("/health");
    const blocked = await request(app).get("/api/v1/recipes");

    // Assert
    expect(create.status).toBe(401);
    expect(create.headers["ratelimit"]).toBeUndefined();
    expect(login.status).toBe(401);
    // /auth tiene sus propias políticas (#39), nunca la cuota del catálogo
    expect(String(login.headers["ratelimit-policy"])).toContain("auth-login-ip");
    expect(String(login.headers["ratelimit-policy"])).not.toContain("recipes-public-read");
    expect(health.status).toBe(200);
    expect(blocked.status).toBe(429);
  });

  it("lleva contadores independientes por IP de cliente (trust proxy de 1 salto y X-Forwarded-For)", async () => {
    // Arrange
    const app = createApp({ limit: 1, trustProxy: 1 });
    const first = await request(app).get("/api/v1/recipes").set("X-Forwarded-For", "203.0.113.10");

    // Act
    const sameIp = await request(app).get("/api/v1/recipes").set("X-Forwarded-For", "203.0.113.10");
    const otherIp = await request(app).get("/api/v1/recipes").set("X-Forwarded-For", "198.51.100.20");

    // Assert
    expect(first.status).toBe(200);
    expect(sameIp.status).toBe(429);
    expect(otherIp.status).toBe(200);
  });

  it("sin trust proxy (default de producción) ignora X-Forwarded-For: no se evade falsificando el header", async () => {
    // Arrange
    const app = createApp({ limit: 1 });
    const first = await request(app).get("/api/v1/recipes").set("X-Forwarded-For", "203.0.113.10");

    // Act
    const spoofed = await request(app).get("/api/v1/recipes").set("X-Forwarded-For", "198.51.100.20");

    // Assert
    expect(first.status).toBe(200);
    expect(spoofed.status).toBe(429);
  });

  it("no consume cuota con el preflight OPTIONS de CORS", async () => {
    // Arrange
    const app = createApp({ limit: 1 });

    // Act
    const preflight = await request(app)
      .options("/api/v1/recipes")
      .set("Origin", "https://app.recetaria.com")
      .set("Access-Control-Request-Method", "GET");
    const get = await request(app).get("/api/v1/recipes");

    // Assert
    expect(preflight.status).toBe(204);
    expect(get.status).toBe(200);
    expect(get.headers["ratelimit"]).toMatch(/r=0;/);
  });

  it("también limita HEAD y variantes de la ruta (mayúsculas y barra final) con la misma cuota", async () => {
    // Arrange
    const app = createApp({ limit: 3 });

    // Act
    const head = await request(app).head("/api/v1/recipes");
    const upper = await request(app).get("/api/v1/RECIPES");
    const trailing = await request(app).get("/api/v1/recipes/");
    const blocked = await request(app).get("/api/v1/recipes");

    // Assert
    expect([head.status, upper.status, trailing.status]).toEqual([200, 200, 200]);
    expect(blocked.status).toBe(429);
  });

  it("agrupa IPv6 por subred /56 para evitar evasión rotando direcciones", async () => {
    // Arrange
    const app = createApp({ limit: 1, trustProxy: 1 });
    // /56 = primeros 56 bits: 2001:0db8:abcd:00xx comparten subred; 2001:0db8:abcd:01xx no
    await request(app).get("/api/v1/recipes").set("X-Forwarded-For", "2001:db8:abcd:12::1");

    // Act
    const sameSubnet = await request(app)
      .get("/api/v1/recipes")
      .set("X-Forwarded-For", "2001:db8:abcd:ff::9999");
    const otherSubnet = await request(app)
      .get("/api/v1/recipes")
      .set("X-Forwarded-For", "2001:db8:abcd:100::1");

    // Assert
    expect(sameSubnet.status).toBe(429);
    expect(otherSubnet.status).toBe(200);
  });

  it("expone los headers de rate limit por CORS para clientes de navegador", async () => {
    // Arrange
    const app = createApp();

    // Act
    const res = await request(app).get("/api/v1/recipes").set("Origin", "https://app.recetaria.com");

    // Assert
    expect(res.status).toBe(200);
    expect(String(res.headers["access-control-expose-headers"]).split(",")).toEqual([
      "RateLimit",
      "RateLimit-Policy",
      "Retry-After",
      "ETag",
    ]);
  });

  it("mantiene los headers CORS expuestos también en la respuesta 429", async () => {
    // Arrange
    const app = createApp({ limit: 1 });
    await exhaust(app, 1);

    // Act
    const res = await request(app).get("/api/v1/recipes").set("Origin", "https://app.recetaria.com");

    // Assert
    expect(res.status).toBe(429);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(String(res.headers["access-control-expose-headers"])).toContain("Retry-After");
  });

  it("puede desactivarse explícitamente con publicRateLimit: false (sin headers ni 429)", async () => {
    // Arrange
    const app = createApp({ disabled: true });

    // Act
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => request(app).get("/api/v1/recipes")),
    );

    // Assert
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.headers["ratelimit"]).toBeUndefined();
    }
  });
});
