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

describe("createRateLimitMiddleware — opciones de #39 (countOnlyFailures, key, message)", () => {
  function createFlexibleHarness(
    config: RateLimitConfig,
    key?: (req: express.Request) => string | undefined,
  ): { readonly app: express.Express; readonly handlerCalls: () => number } {
    let calls = 0;
    const app = express();
    app.get(
      "/attempt",
      createRateLimitMiddleware(config, key === undefined ? undefined : { key }),
      (req, res) => {
        calls += 1;
        res.status(req.query["fail"] === "1" ? 401 : 200).json({ ok: true });
      },
    );
    app.use(createErrorHandlerMiddleware(() => undefined));
    return { app, handlerCalls: () => calls };
  }

  it("con countOnlyFailures los éxitos no consumen cuota y los fallos sí", async () => {
    // Arrange
    const { app } = createFlexibleHarness({ windowMs: 60_000, limit: 2, countOnlyFailures: true });

    // Act: secuencial, porque el descuento de los éxitos ocurre al terminar cada respuesta
    const successes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      successes.push((await request(app).get("/attempt")).status);
    }
    const failures = [
      (await request(app).get("/attempt?fail=1")).status,
      (await request(app).get("/attempt?fail=1")).status,
    ];
    const blockedSuccess = await request(app).get("/attempt");

    // Assert
    expect(successes).toEqual([200, 200, 200, 200, 200]);
    expect(failures).toEqual([401, 401]);
    expect(blockedSuccess.status).toBe(429);
  });

  it("sin countOnlyFailures cuenta todas las solicitudes (comportamiento previo)", async () => {
    // Arrange
    const { app } = createFlexibleHarness({ windowMs: 60_000, limit: 2 });

    // Act
    const statuses = [
      (await request(app).get("/attempt")).status,
      (await request(app).get("/attempt")).status,
      (await request(app).get("/attempt")).status,
    ];

    // Assert
    expect(statuses).toEqual([200, 200, 429]);
  });

  it("con key personalizada lleva contadores por clave e ignora la IP", async () => {
    // Arrange
    const { app } = createFlexibleHarness({ windowMs: 60_000, limit: 1 }, (req) =>
      req.header("x-account"),
    );

    // Act
    const first = await request(app).get("/attempt").set("x-account", "a");
    const sameKey = await request(app).get("/attempt").set("x-account", "a");
    const otherKey = await request(app).get("/attempt").set("x-account", "b");

    // Assert
    expect([first.status, sameKey.status, otherKey.status]).toEqual([200, 429, 200]);
  });

  it("si key devuelve undefined el limitador no aplica (sin headers ni 429)", async () => {
    // Arrange
    const { app, handlerCalls } = createFlexibleHarness({ windowMs: 60_000, limit: 1 }, () => undefined);

    // Act
    const responses = [await request(app).get("/attempt"), await request(app).get("/attempt")];

    // Assert
    expect(responses.map((res) => res.status)).toEqual([200, 200]);
    expect(responses[0]?.headers["ratelimit"]).toBeUndefined();
    expect(handlerCalls()).toBe(2);
  });

  function createChain(ignoreRateLimitedResponses: boolean): express.Express {
    // Limitador "externo" (cuota 2, solo fallos) delante de uno "interno" (cuota 1) que se puede
    // saltear con ?bypass=1 para observar si el externo todavía deja pasar.
    const app = express();
    app.get(
      "/chain",
      createRateLimitMiddleware({
        windowMs: 60_000,
        limit: 2,
        countOnlyFailures: true,
        ignoreRateLimitedResponses,
      }),
      createRateLimitMiddleware({ windowMs: 60_000, limit: 1 }, {
        key: (req) => (req.query["bypass"] === "1" ? undefined : "fija"),
      }),
      (_req, res) => {
        res.status(401).json({ ok: false });
      },
    );
    app.use(createErrorHandlerMiddleware(() => undefined));
    return app;
  }

  it.each([
    [true, 401],
    [false, 429],
  ])(
    "con ignoreRateLimitedResponses=%s los 429 de un limitador posterior %s consumen la cuota del externo",
    async (ignore, expectedAfterBypass) => {
      // Arrange: 1 fallo real (401) y 4 bloqueos del limitador interno (429)
      const app = createChain(ignore);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        statuses.push((await request(app).get("/chain")).status);
      }

      // Act: el interno ya no aplica; solo decide el externo
      const afterBypass = await request(app).get("/chain?bypass=1");

      // Assert: ignorando los 429 el externo solo contó 1 fallo y deja pasar (401 del handler)
      expect(statuses).toEqual([401, 429, 429, 429, 429]);
      expect(afterBypass.status).toBe(expectedAfterBypass);
    },
  );

  it("con exposeHeaders: false no emite RateLimit, RateLimit-Policy ni Retry-After (tampoco en el 429)", async () => {
    // Arrange
    const { app } = createFlexibleHarness({ windowMs: 60_000, limit: 1, exposeHeaders: false });

    // Act
    const allowed = await request(app).get("/attempt");
    const blocked = await request(app).get("/attempt");

    // Assert
    expect(blocked.status).toBe(429);
    for (const res of [allowed, blocked]) {
      expect(res.headers["ratelimit"]).toBeUndefined();
      expect(res.headers["ratelimit-policy"]).toBeUndefined();
      expect(res.headers["retry-after"]).toBeUndefined();
    }
  });

  it("usa el message configurado en el 429 JSend", async () => {
    // Arrange
    const { app } = createFlexibleHarness({ windowMs: 60_000, limit: 1, message: "Mensaje propio" });
    await request(app).get("/attempt");

    // Act
    const res = await request(app).get("/attempt");

    // Assert
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ success: false, statusCode: 429, message: "Mensaje propio", errors: [] });
  });
});
