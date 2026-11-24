import type express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../src/app.js";
import {
  disconnect,
  getDatabase,
  type Database,
} from "../../../src/infrastructure/database/prisma.js";
import {
  IF_MATCH_REQUIRED_MESSAGE,
  IF_MATCH_SINGLE_TAG_MESSAGE,
} from "../../../src/middlewares/if-match.middleware.js";
import { DUMMY_BCRYPT_HASH, type JwtConfig, type UserRole } from "../../../src/modules/auth/index.js";
import {
  RECIPE_ALREADY_APPROVED_MESSAGE,
  RECIPE_APPROVAL_FORBIDDEN_MESSAGE,
  RECIPE_NOT_FOUND_MESSAGE,
  RECIPE_VERSION_MISMATCH_MESSAGE,
} from "../../../src/modules/recipes/index.js";

const TEST_JWT_CONFIG: JwtConfig = {
  secret: "test-jwt-secret-".repeat(3),
  expiresIn: "1h",
};

const USERS = {
  author: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "USER" },
  chef: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", role: "CHEF" },
  nutritionist: { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", role: "NUTRITIONIST" },
} as const satisfies Record<string, Readonly<{ id: string; role: UserRole }>>;

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
/** Receta `DRAFT` cuyo Autor es el `CHEF` (auto-aprobación). */
const CHEF_OWN_ID = "22222222-2222-4222-8222-222222222222";
const MISSING_ID = "99999999-9999-4999-8999-999999999999";

function bearer(user: Readonly<{ id: string; role: UserRole }>): string {
  return `Bearer ${jwt.sign({ id: user.id, role: user.role }, TEST_JWT_CONFIG.secret, { algorithm: "HS256", expiresIn: "1h" })}`;
}

async function truncateTables(db: Database): Promise<void> {
  await db.prisma.$executeRaw`TRUNCATE TABLE "audit_logs", "recipes", "users" RESTART IDENTITY;`;
}

async function seed(db: Database): Promise<void> {
  await db.prisma.user.createMany({
    data: Object.values(USERS).map((user, index) => ({
      id: user.id,
      role: user.role,
      email: `etag-${String(index)}@recetaria.com`,
      passwordHash: DUMMY_BCRYPT_HASH,
      firstName: "Usuario",
      lastName: String(index),
    })),
  });
  await db.prisma.recipe.createMany({
    data: [
      { id: DRAFT_ID, authorId: USERS.author.id, slug: "etag-draft-0a1b2c3d" },
      { id: CHEF_OWN_ID, authorId: USERS.chef.id, slug: "etag-chef-0a1b2c3d" },
    ].map((recipe) => ({
      ...recipe,
      title: "Receta con versión",
      description: "Descripción de prueba del bloqueo optimista.",
      prepTimeMinutes: 30,
      ingredients: [{ name: "Sal", quantity: 1, unit: "g" }],
    })),
  });
}

/** Espera hasta que `expected` sesiones estén bloqueadas en un `SELECT … FOR UPDATE` de `recipes`. */
async function waitForLockWaiters(db: Database, expected: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db.prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query ILIKE '%"recipes"%FOR UPDATE%'`;
    if ((row?.waiting ?? 0) >= expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No se alcanzaron ${String(expected)} sesiones esperando el lock a tiempo`);
}

type TransactionClient = Parameters<Parameters<Database["prisma"]["$transaction"]>[0]>[0];

/** Transacción externa que bloquea la fila hasta `release()` y ejecuta `beforeCommit` con el lock. */
function holdRowLock(
  db: Database,
  recipeId: string,
  beforeCommit: (tx: TransactionClient) => Promise<void>,
): Readonly<{ locked: Promise<void>; release: () => void; done: Promise<void> }> {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markLocked: () => void = () => undefined;
  const locked = new Promise<void>((resolve) => {
    markLocked = resolve;
  });
  const done = db.prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "recipes" WHERE id = ${recipeId}::uuid FOR UPDATE`;
      markLocked();
      await released;
      await beforeCommit(tx);
    },
    { timeout: 15_000 },
  );
  return { locked, release: () => release(), done };
}

describe("Bloqueo optimista en la Aprobación — ETag/If-Match (#46, Integración HTTP + PostgreSQL)", () => {
  let db: Database;
  let app: express.Express;

  beforeAll(() => {
    db = getDatabase();
    app = buildApp({
      prisma: db.prisma,
      jwt: TEST_JWT_CONFIG,
      publicRateLimit: false,
      authRateLimit: false,
      onLog: () => undefined,
      onError: () => undefined,
    });
  });

  beforeEach(async () => {
    await truncateTables(db);
    await seed(db);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await truncateTables(db);
  });

  afterAll(async () => {
    await disconnect();
  });

  // `.then()` dispara el envío de inmediato (Supertest es perezoso hasta que se consume).
  const approve = (
    id: string,
    ifMatch: string | undefined,
    user: Readonly<{ id: string; role: UserRole }> = USERS.chef,
  ) => {
    const req = request(app).put(`/api/v1/recipes/${id}/approve`).set("Authorization", bearer(user));
    return (ifMatch === undefined ? req : req.set("If-Match", ifMatch)).then((res) => res);
  };

  const etagOf = async (id: string): Promise<string> =>
    String((await request(app).get(`/api/v1/recipes/${id}`)).headers["etag"]);

  async function expectUnapproved(id: string): Promise<void> {
    const recipe = await db.prisma.recipe.findUniqueOrThrow({ where: { id } });
    expect(recipe).toMatchObject({ status: "DRAFT", reviewedById: null, publishedAt: null });
    expect(await db.prisma.auditLog.count({ where: { action: "APPROVE" } })).toBe(0);
  }

  describe("ETag de la Receta", () => {
    it("GET /:id expone un ETag fuerte con la versión y sin `version` en el cuerpo", async () => {
      // Act
      const res = await request(app).get(`/api/v1/recipes/${DRAFT_ID}`);

      // Assert
      expect(res.status).toBe(200);
      expect(res.headers["etag"]).toBe('"1"');
      expect(res.body.data).not.toHaveProperty("version");
    });

    it("cambia con cada edición, aprobación y reinicio a borrador, y la respuesta trae el ETag nuevo", async () => {
      // Act
      const edited = await request(app)
        .put(`/api/v1/recipes/${DRAFT_ID}`)
        .set("Authorization", bearer(USERS.author))
        .send({ prepTimeMinutes: 40 });
      const approved = await approve(DRAFT_ID, String(edited.headers["etag"]));
      const reset = await request(app)
        .put(`/api/v1/recipes/${DRAFT_ID}`)
        .set("Authorization", bearer(USERS.author))
        .send({ prepTimeMinutes: 41 });

      // Assert
      expect([edited.status, approved.status, reset.status]).toEqual([200, 200, 200]);
      expect([edited.headers["etag"], approved.headers["etag"], reset.headers["etag"]]).toEqual([
        '"2"',
        '"3"',
        '"4"',
      ]);
      expect(await etagOf(DRAFT_ID)).toBe('"4"');
    });

    it("responde 304 a un GET condicional con el ETag vigente (If-None-Match)", async () => {
      // Act
      const res = await request(app).get(`/api/v1/recipes/${DRAFT_ID}`).set("If-None-Match", '"1"');

      // Assert
      expect(res.status).toBe(304);
    });
  });

  describe("200 OK", () => {
    it("aprueba con el ETag vigente y devuelve el ETag de la versión aprobada", async () => {
      // Arrange
      const etag = await etagOf(DRAFT_ID);

      // Act
      const res = await approve(DRAFT_ID, etag, USERS.nutritionist);

      // Assert
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ data: { status: "APPROVED", reviewedById: USERS.nutritionist.id } });
      expect(res.headers["etag"]).toBe('"2"');
      expect(await db.prisma.auditLog.count({ where: { action: "APPROVE" } })).toBe(1);
    });

    it("rechaza con 400 una lista If-Match: enumerar versiones correlativas equivaldría a un *", async () => {
      // Act
      const res = await approve(DRAFT_ID, Array.from({ length: 20 }, (_, i) => `"${String(i + 1)}"`).join(", "));

      // Assert
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        errors: [{ field: "If-Match", message: IF_MATCH_SINGLE_TAG_MESSAGE }],
      });
      await expectUnapproved(DRAFT_ID);
    });
  });

  describe("428 Precondition Required (en el borde, sin consultar la base)", () => {
    it.each([
      ["sin If-Match", undefined],
      ["con If-Match: *", "*"],
    ])("rechaza %s", async (_label, ifMatch) => {
      // Arrange
      const findUnique = vi.spyOn(db.prisma.recipe, "findUnique");

      // Act
      const res = await approve(DRAFT_ID, ifMatch);

      // Assert
      expect(res.status).toBe(428);
      expect(res.body).toEqual({
        success: false,
        statusCode: 428,
        message: IF_MATCH_REQUIRED_MESSAGE,
        errors: [],
      });
      expect(findUnique).not.toHaveBeenCalled();
      await expectUnapproved(DRAFT_ID);
    });

    it("control positivo del espía: con If-Match válido el servicio sí consulta la base", async () => {
      // Arrange
      const findUnique = vi.spyOn(db.prisma.recipe, "findUnique");

      // Act
      await approve(DRAFT_ID, '"1"');

      // Assert
      expect(findUnique).toHaveBeenCalled();
    });

    it("428 antes que el 403 de RN-05: el Autor CHEF sin If-Match no llega a la base", async () => {
      expect((await approve(CHEF_OWN_ID, undefined)).status).toBe(428);
    });
  });

  describe("400 Bad Request", () => {
    it("rechaza un If-Match con sintaxis inválida", async () => {
      // Act
      const res = await approve(DRAFT_ID, "1");

      // Assert
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ errors: [{ field: "If-Match" }] });
      await expectUnapproved(DRAFT_ID);
    });
  });

  describe("412 Precondition Failed", () => {
    it.each([
      ["un ETag arbitrario", '"abc"'],
      ["el ETag débil de la versión vigente", 'W/"1"'],
      ["un ETag de otra versión", '"2"'],
    ])("rechaza %s sin aprobar ni auditar", async (_label, ifMatch) => {
      // Act
      const res = await approve(DRAFT_ID, ifMatch);

      // Assert
      expect(res.status).toBe(412);
      expect(res.body).toEqual({
        success: false,
        statusCode: 412,
        message: RECIPE_VERSION_MISMATCH_MESSAGE,
        errors: [],
      });
      await expectUnapproved(DRAFT_ID);
    });

    it("rechaza el ETag que el revisor leyó si el Autor editó después (caso secuencial)", async () => {
      // Arrange
      const reviewed = await etagOf(DRAFT_ID);
      await request(app)
        .put(`/api/v1/recipes/${DRAFT_ID}`)
        .set("Authorization", bearer(USERS.author))
        .send({ title: "Contenido cambiado" });

      // Act
      const res = await approve(DRAFT_ID, reviewed);

      // Assert
      expect(res.status).toBe(412);
      await expectUnapproved(DRAFT_ID);
    });
  });

  describe("Orden de guardas: 401 → 403 RBAC → 428 → 400 → 404 → 403 RN-05 → 412 → 409", () => {
    it("401 sin token, aunque falte If-Match y el :id sea inválido", async () => {
      expect((await request(app).put("/api/v1/recipes/abc/approve")).status).toBe(401);
    });

    it("403 RBAC para un USER, aunque falte If-Match", async () => {
      expect((await approve("abc", undefined, USERS.author)).status).toBe(403);
    });

    it("428 antes que 400: CHEF sin If-Match y con :id inválido", async () => {
      expect((await approve("abc", undefined)).status).toBe(428);
    });

    it("400 por :id inválido con If-Match presente", async () => {
      const res = await approve("abc", '"1"');
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ errors: [{ field: "id" }] });
    });

    it("404 antes que 412: receta inexistente con un ETag cualquiera", async () => {
      const res = await approve(MISSING_ID, '"999"');
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ message: RECIPE_NOT_FOUND_MESSAGE });
    });

    it("403 de auto-aprobación (RN-05) antes que 412: no revela la versión al Autor", async () => {
      const res = await approve(CHEF_OWN_ID, '"999"');
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ message: RECIPE_APPROVAL_FORBIDDEN_MESSAGE });
    });

    it("412 antes que 409 con un ETag viejo de una receta ya aprobada; 409 con el ETag vigente", async () => {
      // Arrange
      const first = await approve(DRAFT_ID, '"1"');
      expect(first.status).toBe(200);

      // Act
      const stale = await approve(DRAFT_ID, '"1"', USERS.nutritionist);
      const current = await approve(DRAFT_ID, String(first.headers["etag"]), USERS.nutritionist);

      // Assert
      expect(stale.status).toBe(412);
      expect(current.status).toBe(409);
      expect(current.body).toMatchObject({ message: RECIPE_ALREADY_APPROVED_MESSAGE });
      expect(await db.prisma.auditLog.count({ where: { action: "APPROVE" } })).toBe(1);
    });
  });

  describe("Carrera determinista: edición confirmada mientras la aprobación espera el lock", () => {
    it("la aprobación con el ETag que el revisor leyó recibe 412 y no aprueba contenido no revisado", async () => {
      // Arrange — el revisor lee la versión 1; el Autor edita y confirma mientras la aprobación
      // (que ya superó el chequeo del servicio con la versión 1) espera el lock de la fila.
      const reviewed = await etagOf(DRAFT_ID);
      const holder = holdRowLock(db, DRAFT_ID, async (tx) => {
        await tx.recipe.update({ where: { id: DRAFT_ID }, data: { title: "Contenido no revisado" } });
      });
      await holder.locked;

      // Act
      const pending = approve(DRAFT_ID, reviewed);
      try {
        await waitForLockWaiters(db, 1);
      } finally {
        holder.release();
        await holder.done;
      }
      const res = await pending;

      // Assert
      expect(reviewed).toBe('"1"');
      expect(res.status).toBe(412);
      expect(res.body).toMatchObject({ message: RECIPE_VERSION_MISMATCH_MESSAGE });
      const persisted = await db.prisma.recipe.findUniqueOrThrow({ where: { id: DRAFT_ID } });
      expect(persisted).toMatchObject({ title: "Contenido no revisado", status: "DRAFT", version: 2 });
      expect(await db.prisma.auditLog.count()).toBe(0);

      // Tras releer el contenido nuevo (versión 2), la aprobación procede
      const retry = await approve(DRAFT_ID, await etagOf(DRAFT_ID));
      expect(retry.status).toBe(200);
    });
  });

  describe("CORS", () => {
    it("el preflight permite enviar If-Match desde navegadores", async () => {
      // Act
      const res = await request(app)
        .options(`/api/v1/recipes/${DRAFT_ID}/approve`)
        .set("Origin", "https://app.recetaria.com")
        .set("Access-Control-Request-Method", "PUT")
        .set("Access-Control-Request-Headers", "authorization,if-match");

      // Assert
      expect(res.status).toBe(204);
      expect(String(res.headers["access-control-allow-headers"]).split(",")).toContain("If-Match");
    });

    it("expone ETag para que el cliente pueda leerlo y encadenarlo", async () => {
      // Act
      const res = await request(app).get(`/api/v1/recipes/${DRAFT_ID}`).set("Origin", "https://app.recetaria.com");

      // Assert
      expect(String(res.headers["access-control-expose-headers"]).split(",")).toContain("ETag");
    });
  });
});
