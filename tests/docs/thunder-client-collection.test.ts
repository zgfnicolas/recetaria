import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_SEED_PASSWORD, seedUsers } from "../../prisma/seed.js";
import { buildApp } from "../../src/app.js";
import { disconnect, getDatabase, type Database } from "../../src/infrastructure/database/prisma.js";
import { truncateAll } from "../support/database.js";
import { E2E_JWT_CONFIG } from "../support/e2e.js";
import { ROUTE_CATALOG } from "../support/route-catalog.js";

/**
 * Colección exportada de Thunder Client (#23): válida, sincronizada con las rutas reales y
 * **ejecutable**. El formato se calibró con Thunder Client 3.2.7 (tests `res-code`/`set-env-var`,
 * acciones `equal`/`setto`, auth `bearer`; entorno `clientName`/`environmentName`/`variables`).
 */

const DOCS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docs");
const COLLECTION_FILE = path.join(DOCS_DIR, "thunder-client-collection.json");
const ENVIRONMENT_FILE = path.join(DOCS_DIR, "thunder-client-environment.json");

const EXPECTED_FOLDERS = [
  "Health",
  "Auth",
  "Recipes — Happy Path",
  "Recipes — Filtros y Paginación",
  "Recipes — Errores y RBAC",
  "Users — Administración",
  "Cleanup",
] as const;

/** Variables del sistema de Thunder Client que usa la colección (y que el intérprete emula). */
const SUPPORTED_SYSTEM_VARIABLES = ["email", "guid"] as const;

/** Códigos HTTP obligatorios del ticket (#23) más los del bloqueo optimista (#46). */
const REQUIRED_STATUS_CODES = ["200", "201", "400", "401", "403", "404", "409", "412", "428"] as const;

const nameValueSchema = z.strictObject({ name: z.string().min(1), value: z.string() });

const testSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("res-code"), custom: z.literal(""), action: z.literal("equal"), value: z.string().regex(/^\d{3}$/) }),
  z.strictObject({
    type: z.literal("set-env-var"),
    custom: z.string().regex(/^(?:json\.[\w.]+|header\.[a-z0-9-]+)$/),
    action: z.literal("setto"),
    value: z.string().regex(/^\{\{\w+\}\}$/),
  }),
]);

const requestSchema = z.strictObject({
  _id: z.uuid(),
  colId: z.uuid(),
  containerId: z.uuid(),
  name: z.string().regex(/^\[\d{3}\] /, { error: "el nombre empieza con el código esperado, p. ej. [200]" }),
  url: z.string().startsWith("{{baseUrl}}/"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  sortNum: z.int().positive(),
  created: z.iso.datetime(),
  modified: z.iso.datetime(),
  headers: z.array(nameValueSchema),
  body: z.strictObject({ type: z.literal("json"), raw: z.string(), form: z.array(nameValueSchema) }).optional(),
  auth: z.strictObject({ type: z.literal("bearer"), bearer: z.string().min(1) }).optional(),
  tests: z
    .array(testSchema)
    .refine((tests) => tests.filter((t) => t.type === "res-code").length === 1, {
      error: "cada pedido declara exactamente un código HTTP esperado (res-code)",
    }),
});

const collectionSchema = z.strictObject({
  clientName: z.literal("Thunder Client"),
  collectionName: z.string().min(1),
  collectionId: z.uuid(),
  dateExported: z.iso.datetime(),
  version: z.literal("1.2"),
  // Thunder Client 3.2.7 solo reconoce el formato nativo si `ref` existe y no está vacío.
  ref: z.string().min(1),
  folders: z.array(
    z.strictObject({
      _id: z.uuid(),
      name: z.string().min(1),
      containerId: z.literal(""),
      created: z.iso.datetime(),
      sortNum: z.int().positive(),
    }),
  ),
  requests: z.array(requestSchema).min(1),
});

const environmentSchema = z.strictObject({
  clientName: z.literal("Thunder Client"),
  environmentName: z.string().min(1),
  environmentId: z.uuid(),
  dateExported: z.iso.datetime(),
  version: z.literal("1.2"),
  ref: z.string().min(1),
  variables: z.array(nameValueSchema),
});

type Collection = z.infer<typeof collectionSchema>;

const VERBS = { GET: "get", POST: "post", PUT: "put", PATCH: "patch", DELETE: "delete" } as const;
type CollectionRequest = Collection["requests"][number];

function load<T>(schema: z.ZodType<T>, file: string): T {
  return schema.parse(JSON.parse(readFileSync(file, "utf8")));
}

const collection = load(collectionSchema, COLLECTION_FILE);
const environment = load(environmentSchema, ENVIRONMENT_FILE);

/** Orden de "Run All": carpetas por `sortNum` y, dentro de cada una, pedidos por `sortNum`. */
function inRunOrder(col: Collection): CollectionRequest[] {
  const folderOrder = new Map(col.folders.map((f) => [f._id, f.sortNum]));
  return [...col.requests].sort(
    (a, b) => (folderOrder.get(a.containerId) ?? 0) - (folderOrder.get(b.containerId) ?? 0) || a.sortNum - b.sortNum,
  );
}

function expectedStatus(req: CollectionRequest): string {
  const test = req.tests.find((t) => t.type === "res-code");
  if (test === undefined) {
    throw new Error(`"${req.name}" no declara el código HTTP esperado`);
  }
  return test.value;
}

/** `{{baseUrl}}/api/v1/recipes/{{recipeId}}/approve?x=1` → ruta del catálogo (`PUT /api/v1/recipes/:id/approve`). */
function catalogKeyOf(req: CollectionRequest): string | undefined {
  const pathname = req.url.replace("{{baseUrl}}", "").split("?")[0] ?? "";
  const keys = Object.keys(ROUTE_CATALOG).filter((key) => key.startsWith(`${req.method} `));
  const exact = keys.find((key) => key === `${req.method} ${pathname}`);
  if (exact !== undefined) {
    return exact;
  }
  return keys.find((key) => {
    const pattern = key.slice(req.method.length + 1).replaceAll(":id", "[^/]+");
    return new RegExp(`^${pattern}$`).test(pathname);
  });
}

describe("Colección Thunder Client (docs/thunder-client-collection.json, #23)", () => {
  describe("validez del formato", () => {
    it("la colección y el entorno cumplen el formato de exportación 1.2 de Thunder Client", () => {
      // El parseo con los esquemas estrictos ocurre al cargar el módulo; aquí, que no estén vacíos.
      expect(collection.requests).not.toHaveLength(0);
      expect(environment.variables.map((v) => v.name)).toContain("baseUrl");
    });

    it("las carpetas son las acordadas, en orden, y cada pedido pertenece a una de ellas", () => {
      const folders = [...collection.folders].sort((a, b) => a.sortNum - b.sortNum).map((f) => f.name);
      expect(folders).toEqual(EXPECTED_FOLDERS);
      const folderIds = new Set(collection.folders.map((f) => f._id));
      for (const req of collection.requests) {
        expect(folderIds.has(req.containerId), req.name).toBe(true);
        expect(req.colId).toBe(collection.collectionId);
      }
    });

    it("los _id son únicos y los bodies son JSON válido", () => {
      const ids = [...collection.folders.map((f) => f._id), ...collection.requests.map((r) => r._id)];
      expect(new Set(ids).size).toBe(ids.length);
      for (const req of collection.requests) {
        if (req.body !== undefined) {
          expect(() => JSON.parse(req.body?.raw ?? ""), req.name).not.toThrow();
        }
      }
    });

    it("el nombre de cada pedido coincide con el código que asegura su test", () => {
      for (const req of collection.requests) {
        expect(req.name.slice(1, 4), req.name).toBe(expectedStatus(req));
      }
    });
  });

  describe("cobertura", () => {
    it("cubre exactamente los endpoints del catálogo de la API (ni de más ni de menos)", () => {
      const unknown = collection.requests.filter((req) => catalogKeyOf(req) === undefined).map((req) => req.name);
      const covered = new Set(collection.requests.map(catalogKeyOf));
      const missing = Object.keys(ROUTE_CATALOG).filter((key) => !covered.has(key));
      expect({ unknown, missing }).toEqual({ unknown: [], missing: [] });
    });

    it.each(REQUIRED_STATUS_CODES)("incluye al menos un caso que espera %s", (status) => {
      expect(collection.requests.some((req) => expectedStatus(req) === status)).toBe(true);
    });

    it.each([
      ["403", "RN-02"],
      ["403", "RN-03"],
      ["403", "RN-04"],
      ["403", "RN-05"],
      ["400", "RN-07"],
      ["400", "BOPLA"],
      ["409", "duplicado"],
      ["409", "Doble aprobación"],
      ["404", "inexistente"],
    ])("incluye un caso %s de %s", (status, marker) => {
      expect(collection.requests.some((req) => expectedStatus(req) === status && req.name.includes(marker))).toBe(true);
    });

    it("usa los 4 usuarios semilla", () => {
      const bodies = collection.requests.map((req) => req.body?.raw ?? "").join("\n");
      for (const seed of ["user", "chef", "nutri", "admin"]) {
        expect(bodies).toContain(`"${seed}@recetaria.com"`);
      }
    });
  });

  describe("higiene (sin secretos ni valores fijos de entorno)", () => {
    const raw = readFileSync(COLLECTION_FILE, "utf8") + readFileSync(ENVIRONMENT_FILE, "utf8");

    it("no contiene JWT literales, cadenas de conexión ni secretos de configuración", () => {
      expect(raw).not.toMatch(/eyJ[\w-]{10,}\.[\w-]{10,}/);
      expect(raw).not.toMatch(/postgres(?:ql)?:\/\//i);
      expect(raw).not.toMatch(/JWT_SECRET|DATABASE_URL/);
      // El único host es el de `baseUrl` en el entorno: ni URLs, ni headers ni bodies lo repiten.
      expect(readFileSync(COLLECTION_FILE, "utf8")).not.toMatch(/localhost|127\.0\.0\.1|https?:\/\//);
    });

    it("los headers solo llevan If-Match (variable o un ETag literal obsoleto): ningún Authorization manual", () => {
      for (const req of collection.requests) {
        for (const header of req.headers) {
          expect(header.name, req.name).toBe("If-Match");
          expect(/^\{\{\w+\}\}$/.test(header.value) || /^"\d+"$/.test(header.value), req.name).toBe(true);
        }
      }
    });

    it("los tokens Bearer son variables (salvo el caso deliberadamente inválido)", () => {
      for (const req of collection.requests) {
        if (req.auth !== undefined) {
          expect(/^\{\{\w+Token\}\}$/.test(req.auth.bearer) || req.auth.bearer === "token-invalido", req.name).toBe(true);
        }
      }
    });

    it("las únicas contraseñas son de desarrollo: la del seed, la del usuario de prueba y una incorrecta a propósito", () => {
      const allowed = new Set([DEFAULT_SEED_PASSWORD, "Password-segura-1", "contraseña-incorrecta"]);
      const passwords = collection.requests.flatMap((req) => {
        const body: unknown = req.body === undefined ? undefined : JSON.parse(req.body.raw);
        const password = typeof body === "object" && body !== null ? Reflect.get(body, "password") : undefined;
        return typeof password === "string" ? [password] : [];
      });
      expect(passwords.length).toBeGreaterThan(0);
      expect(passwords.filter((password) => !allowed.has(password))).toEqual([]);
    });

    it("el entorno solo trae baseUrl con valor; el resto lo completa la colección", () => {
      const withValue = environment.variables.filter((v) => v.value !== "");
      expect(withValue).toEqual([{ name: "baseUrl", value: "http://localhost:3000" }]);
    });

    it("solo usa variables del sistema que el intérprete emula ({{#email}}, {{#guid}})", () => {
      const systemVars = new Set([...raw.matchAll(/\{\{#(\w+)\}\}/g)].map((m) => m[1] ?? ""));
      expect([...systemVars].filter((name) => !SUPPORTED_SYSTEM_VARIABLES.some((s) => s === name))).toEqual([]);
    });

    it("toda variable usada existe en el entorno (salvo las del sistema {{#...}})", () => {
      const declared = new Set(environment.variables.map((v) => v.name));
      const used = new Set([...raw.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] ?? ""));
      expect([...used].filter((name) => !declared.has(name))).toEqual([]);
    });
  });

  describe("ejecución real en el orden de Run All (buildApp + PostgreSQL + seed)", () => {
    let db: Database;
    let app: express.Express;

    beforeAll(async () => {
      db = getDatabase();
      await truncateAll(db);
      await seedUsers(db.prisma, { password: DEFAULT_SEED_PASSWORD });
      app = buildApp({
        prisma: db.prisma,
        jwt: E2E_JWT_CONFIG,
        publicRateLimit: false,
        authRateLimit: false,
        onLog: () => undefined,
        onError: () => undefined,
      });
    });

    afterAll(async () => {
      try {
        await truncateAll(db);
      } finally {
        await disconnect();
      }
    });

    /** Sustituye `{{var}}` del entorno y las variables del sistema que usa la colección. */
    function resolve(text: string, vars: Map<string, string>): string {
      return text
        .replaceAll("{{#email}}", () => `evaluador-${randomUUID().slice(0, 8)}@recetaria.com`)
        .replaceAll("{{#guid}}", () => randomUUID())
        .replace(/\{\{#(\w+)\}\}/g, (_match, name: string) => {
          throw new Error(`Variable del sistema {{#${name}}} no emulada por el intérprete`);
        })
        .replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
          const value = vars.get(name);
          if (value === undefined || value === "") {
            throw new Error(`Variable {{${name}}} sin valor al ejecutar la colección`);
          }
          return value;
        });
    }

    function readCapture(source: string, res: request.Response): string {
      if (source.startsWith("header.")) {
        return String(res.headers[source.slice("header.".length).toLowerCase()] ?? "");
      }
      const value = source
        .slice("json.".length)
        .split(".")
        .reduce<unknown>((node, key) => (typeof node === "object" && node !== null ? Reflect.get(node, key) : undefined), res.body);
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
    }

    it("cada pedido responde exactamente el código que declara y captura sus variables", async () => {
      const vars = new Map(environment.variables.map((v) => [v.name, v.value]));
      const baseUrl = vars.get("baseUrl") ?? "";
      const results: string[] = [];

      for (const req of inRunOrder(collection)) {
        try {
          // Arrange
          const url = resolve(req.url, vars).replace(baseUrl, "");
          let call = request(app)[VERBS[req.method]](url);
          for (const header of req.headers) {
            call = call.set(header.name, resolve(header.value, vars));
          }
          if (req.auth !== undefined) {
            call = call.set("Authorization", `Bearer ${resolve(req.auth.bearer, vars)}`);
          }
          if (req.body !== undefined) {
            call = call.set("Content-Type", "application/json").send(resolve(req.body.raw, vars));
          }

          // Act
          const res = await call;

          // Assert — se acumula para reportar todos los desvíos juntos
          const expected = expectedStatus(req);
          results.push(`${String(res.status) === expected ? "ok " : "FALLA"} ${req.name} → ${String(res.status)}`);
          for (const test of req.tests) {
            if (test.type === "set-env-var") {
              vars.set(test.value.slice(2, -2), readCapture(test.custom, res));
            }
          }
        } catch (err: unknown) {
          // Una variable sin capturar (o no emulada) no corta la corrida: se reporta y se sigue.
          results.push(`FALLA ${req.name} → ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      expect(results.filter((line) => line.startsWith("FALLA"))).toEqual([]);
      expect(results).toHaveLength(collection.requests.length);
    }, 60_000);
  });
});
