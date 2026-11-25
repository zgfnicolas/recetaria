import { randomUUID } from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type MountedRouter } from "../../src/app.js";
import { buildApiRouters } from "../../src/bootstrap/container.js";
import { disconnect, getDatabase, type Database } from "../../src/infrastructure/database/prisma.js";
import { E2E_JWT_CONFIG } from "../support/e2e.js";
import { createExposureRecorder } from "../support/exposure.js";
import { ROUTE_CATALOG } from "../support/route-catalog.js";
import { discoverRoutes, routeKey, type DiscoveredRoute } from "../support/route-discovery.js";

const TEST_JWT_CONFIG = E2E_JWT_CONFIG;

const PRIVATE_ROUTES = Object.entries(ROUTE_CATALOG)
  .filter(([, entry]) => !entry.public)
  .map(([key]) => key);
const PUBLIC_ROUTES = Object.entries(ROUTE_CATALOG)
  .filter(([, entry]) => entry.public)
  .map(([key]) => key);

const VERBS = {
  GET: "get",
  POST: "post",
  PUT: "put",
  PATCH: "patch",
  DELETE: "delete",
  HEAD: "head",
} as const satisfies Readonly<Record<string, "get" | "post" | "put" | "patch" | "delete" | "head">>;

function isVerb(method: string): method is keyof typeof VERBS {
  return Object.hasOwn(VERBS, method);
}

function toRequest(app: express.Express, key: string): request.Test {
  const [method = "", path = ""] = key.split(" ");
  if (!isVerb(method)) {
    throw new Error(`Método sin soporte en la prueba: ${method}`);
  }
  return request(app)[VERBS[method]](path.replaceAll(":id", randomUUID()));
}

/** Variantes de credencial inválida que toda ruta privada debe rechazar con `401`. */
const INVALID_CREDENTIALS: readonly Readonly<{ label: string; header: () => string | undefined }>[] = [
  { label: "sin Authorization", header: () => undefined },
  {
    label: "Bearer con firma inválida",
    header: () => `Bearer ${jwt.sign({ id: randomUUID(), role: "ADMIN" }, "otro-secreto-".repeat(4), { algorithm: "HS256", expiresIn: "1h" })}`,
  },
  {
    label: "JWT válido de un usuario inexistente",
    header: () => `Bearer ${jwt.sign({ id: randomUUID(), role: "ADMIN" }, TEST_JWT_CONFIG.secret, { algorithm: "HS256", expiresIn: "1h" })}`,
  },
];

async function unauthenticatedSuccesses(app: express.Express, keys: readonly string[]): Promise<string[]> {
  const leaks: string[] = [];
  for (const key of keys) {
    const res = await toRequest(app, key).send({});
    if (res.status < 400) {
      leaks.push(`${key} → ${String(res.status)}`);
    }
  }
  return leaks;
}

function diffCatalog(discovered: readonly DiscoveredRoute[]): Readonly<{ unclassified: string[]; stale: string[] }> {
  const keys = new Set(discovered.map(routeKey));
  return {
    unclassified: [...keys].filter((key) => !(key in ROUTE_CATALOG)).sort(),
    stale: Object.keys(ROUTE_CATALOG).filter((key) => !keys.has(key)).sort(),
  };
}

describe("E2E — rutas privadas por defecto (#22, OWASP API2/API5)", () => {
  let db: Database;
  let mounted: readonly MountedRouter[];
  let app: express.Express;
  const exposure = createExposureRecorder([TEST_JWT_CONFIG.secret]);

  beforeAll(() => {
    db = getDatabase();
    // Mismo cableado que `buildApp({ prisma })`: se pasan los routers del contenedor para poder
    // identificarlos por referencia al descubrir las rutas montadas bajo `/api/v1`.
    mounted = buildApiRouters(db.prisma, { jwt: TEST_JWT_CONFIG, publicRateLimit: false, authRateLimit: false });
    app = buildApp({
      prisma: db.prisma,
      jwt: TEST_JWT_CONFIG,
      apiRouters: mounted,
      onLog: () => undefined,
      onError: () => undefined,
    });
  });

  afterAll(async () => {
    try {
      exposure.assertNoSensitiveExposure();
    } finally {
      await disconnect();
    }
  });

  it("el catálogo declarado coincide exactamente con las rutas registradas en la app", () => {
    // Act
    const discovered = discoverRoutes(app, mounted);

    // Assert — sin rutas sin clasificar ni entradas obsoletas
    expect(discovered.length).toBeGreaterThan(0);
    expect(diffCatalog(discovered)).toEqual({ unclassified: [], stale: [] });
  });

  describe.each(INVALID_CREDENTIALS)("toda ruta privada responde 401 JSend — $label", ({ header }) => {
    it.each(PRIVATE_ROUTES)("%s", async (key) => {
      // Arrange
      const req = toRequest(app, key);
      const value = header();
      if (value !== undefined) {
        req.set("Authorization", value);
      }

      // Act — body inválido a propósito: authGuard corre antes que Zod (ADR-0006)
      const res = await exposure.track(req.send({ unexpected: true }));

      // Assert
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ success: false, statusCode: 401 });
    });
  });

  it.each(PRIVATE_ROUTES.filter((key) => key.startsWith("GET ")))("HEAD sobre %s también exige autenticación", async (key) => {
    const res = await exposure.track(toRequest(app, key.replace(/^GET /, "HEAD ")));
    expect(res.status).toBe(401);
  });

  it.each(PUBLIC_ROUTES)("la ruta pública %s responde sin token (nunca 401 ni 5xx)", async (key) => {
    const res = await exposure.track(toRequest(app, key).send({}));
    expect(res.status).not.toBe(401);
    expect(res.status).toBeLessThan(500);
  });

  it("autoverificación: una ruta nueva sin authGuard se detecta como no clasificada y como fuga", async () => {
    // Arrange — app con un router extra montado sin authGuard
    const leakyRouter = express.Router();
    leakyRouter.get("/export", (_req, res) => {
      res.json({ success: true });
    });
    const leakyMounted = [...mounted, { path: "/admin", router: leakyRouter }];
    const leakyApp = buildApp({ prisma: db.prisma, jwt: TEST_JWT_CONFIG, apiRouters: leakyMounted, onLog: () => undefined });

    // Act
    const diff = diffCatalog(discoverRoutes(leakyApp, leakyMounted));
    const leaks = await unauthenticatedSuccesses(leakyApp, [...PRIVATE_ROUTES, ...diff.unclassified]);

    // Assert
    expect(diff.unclassified).toEqual(["GET /api/v1/admin/export"]);
    expect(leaks).toEqual(["GET /api/v1/admin/export → 200"]);
  });

  it("autoverificación: un handler montado con app.use(path, fn) hace fallar el descubrimiento (no se omite)", () => {
    // Arrange — endpoint que responde sin ser una ruta ni un router
    const raw = express();
    raw.use("/export", (_req, res) => {
      res.json({ success: true });
    });

    // Act & Assert
    expect(() => discoverRoutes(raw, [])).toThrow(/app\.use\(path, fn\)/);
  });
});
