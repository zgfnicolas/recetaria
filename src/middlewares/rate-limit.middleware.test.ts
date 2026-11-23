import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createErrorHandlerMiddleware } from "./error-handler.middleware.js";
import {
  createRateLimitMiddleware,
  DEFAULT_PUBLIC_READ_RATE_LIMIT,
  RATE_LIMIT_EXCEEDED_MESSAGE,
  type RateLimitConfig,
} from "./rate-limit.middleware.js";

function createHarness(config?: RateLimitConfig): {
  readonly app: express.Express;
  readonly handlerCalls: () => number;
} {
  let calls = 0;
  const app = express();
  app.get("/limited", createRateLimitMiddleware(config), (_req, res) => {
    calls += 1;
    res.status(200).json({ ok: true });
  });
  app.use(createErrorHandlerMiddleware(() => undefined));
  return { app, handlerCalls: () => calls };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("createRateLimitMiddleware (#36, OWASP API4)", () => {
  it("expone por defecto 120 solicitudes por minuto con la política recipes-public-read", () => {
    expect(DEFAULT_PUBLIC_READ_RATE_LIMIT).toEqual({
      windowMs: 60_000,
      limit: 120,
      identifier: "recipes-public-read",
    });
    expect(Object.isFrozen(DEFAULT_PUBLIC_READ_RATE_LIMIT)).toBe(true);
  });

  it("permite hasta el límite con headers draft-8 y sin headers X-RateLimit legados", async () => {
    // Arrange
    const { app } = createHarness({ windowMs: 60_000, limit: 2, identifier: "test" });

    // Act
    const first = await request(app).get("/limited");
    const second = await request(app).get("/limited");

    // Assert
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers["ratelimit-policy"]).toMatch(/^"test"; q=2; w=60; pk=:[A-Za-z0-9+/=]+:$/);
    expect(first.headers["ratelimit"]).toMatch(/^"test"; r=1; t=\d+$/);
    expect(second.headers["ratelimit"]).toMatch(/^"test"; r=0; t=\d+$/);
    expect(first.headers["x-ratelimit-limit"]).toBeUndefined();
    expect(first.headers["retry-after"]).toBeUndefined();
  });

  it("responde 429 en JSend con Retry-After al exceder el límite sin invocar el handler protegido", async () => {
    // Arrange
    const { app, handlerCalls } = createHarness({ windowMs: 60_000, limit: 1 });
    await request(app).get("/limited");

    // Act
    const res = await request(app).get("/limited");

    // Assert
    expect(res.status).toBe(429);
    expect(handlerCalls()).toBe(1);
    expect(res.headers["ratelimit-policy"]).toMatch(/^"1-per-60000ms"; q=1; w=60;/);
    expect(res.body).toEqual({
      success: false,
      statusCode: 429,
      message: RATE_LIMIT_EXCEEDED_MESSAGE,
      errors: [],
    });
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(res.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect(res.headers["ratelimit"]).toMatch(/r=0;/);
  });

  it("restablece la cuota al vencer la ventana", async () => {
    // Arrange: ventana de 1 s con margen amplio para CI lento (las 2 primeras solicitudes
    // deben caer dentro de la ventana; se verifica antes de esperar).
    const { app } = createHarness({ windowMs: 1_000, limit: 1 });
    await request(app).get("/limited");
    const blocked = await request(app).get("/limited");
    expect(blocked.status).toBe(429);

    // Act
    await delay(1_500);
    const afterWindow = await request(app).get("/limited");

    // Assert
    expect(afterWindow.status).toBe(200);
  });

  it("mantiene contadores independientes por instancia (sin store compartido entre apps)", async () => {
    // Arrange
    const { app: first } = createHarness({ windowMs: 60_000, limit: 1 });
    const { app: second } = createHarness({ windowMs: 60_000, limit: 1 });
    await request(first).get("/limited");

    // Act
    const res = await request(second).get("/limited");

    // Assert
    expect(res.status).toBe(200);
  });

  it.each([
    { windowMs: 0, limit: 10 },
    { windowMs: 1.5, limit: 10 },
    { windowMs: 1000, limit: 0 },
    { windowMs: 1000, limit: -1 },
    { windowMs: 1000, limit: 2.5 },
    { windowMs: Number.NaN, limit: 10 },
    { windowMs: Number.POSITIVE_INFINITY, limit: 10 },
    { windowMs: 1000, limit: Number.NaN },
    { windowMs: 1000, limit: Number.POSITIVE_INFINITY },
  ])("rechaza configuraciones inválidas %o con RangeError (fail fast)", (config) => {
    expect(() => createRateLimitMiddleware(config)).toThrow(RangeError);
  });
});
