import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Prisma, type Role } from "../../../src/generated/prisma/client.js";
import {
  disconnect,
  getDatabase,
  type Database,
} from "../../../src/infrastructure/database/prisma.js";

type DbErrorInfo = {
  readonly prismaCode: string | undefined;
  readonly sqlState: string | undefined;
  readonly kind: string | undefined;
  readonly message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function inspectDbError(err: unknown): DbErrorInfo {
  const prismaCode =
    err instanceof Prisma.PrismaClientKnownRequestError ? err.code : undefined;

  const messages: string[] = [];
  if (err instanceof Error) {
    messages.push(err.message);
  } else {
    messages.push(String(err));
  }

  let sqlState: string | undefined;
  let kind: string | undefined;

  const visited = new Set<unknown>();
  const queue: unknown[] = [err];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!isRecord(current) || visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (typeof current["message"] === "string") {
      messages.push(current["message"]);
    }

    const code = current["code"];
    if (
      sqlState === undefined &&
      typeof code === "string" &&
      /^[0-9A-Z]{5}$/.test(code) &&
      !(current instanceof Prisma.PrismaClientKnownRequestError) &&
      !/^P\d{4}$/.test(code)
    ) {
      sqlState = code;
    }

    if (kind === undefined && typeof current["kind"] === "string") {
      kind = current["kind"];
    }

    if ("cause" in current) {
      queue.push(current["cause"]);
    }

    if ("meta" in current && isRecord(current["meta"])) {
      queue.push(current["meta"]);
    }

    if ("driverAdapterError" in current) {
      queue.push(current["driverAdapterError"]);
    }
  }

  return { prismaCode, sqlState, kind, message: messages.join("\n") };
}

async function expectCheckViolation(
  action: () => Promise<unknown>,
  constraintName: string,
): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (err: unknown) {
    caught = err;
  }

  expect(caught).toBeDefined();
  const info = inspectDbError(caught);
  expect(info.sqlState).toBe("23514");
  expect(info.message).toContain(constraintName);
}

async function truncateTables(db: Database): Promise<void> {
  await db.prisma.$executeRaw`TRUNCATE TABLE "audit_logs", "recipes", "users" RESTART IDENTITY;`;
}

type CreateUserOptions = {
  email?: string;
  firstName?: string;
  lastName?: string;
  role?: Role;
  updatedAt?: Date;
};

async function createUser(db: Database, options?: CreateUserOptions) {
  const suffix = randomUUID().slice(0, 8);
  return db.prisma.user.create({
    data: {
      email: options?.email ?? `usuario-${suffix}@recetaria.test`,
      passwordHash: "$2b$10$EpRnTzVlqHNP0.fUbXUwSOyuiXe/QLSUG6xNekdHgTGmrpHEfIoxm",
      firstName: options?.firstName ?? "Nombre",
      lastName: options?.lastName ?? "Apellido",
      ...(options?.role !== undefined ? { role: options.role } : {}),
      ...(options?.updatedAt !== undefined ? { updatedAt: options.updatedAt } : {}),
    },
  });
}

type CreateRecipeOptions = {
  title?: string;
  slug?: string;
  prepTimeMinutes?: number;
  ingredients?: Prisma.InputJsonValue;
  nutritionalInfo?: Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue;
  reviewedById?: string | null;
  updatedAt?: Date;
};

function buildRecipeData(
  authorId: string,
  options?: CreateRecipeOptions,
): Prisma.RecipeUncheckedCreateInput {
  const suffix = randomUUID().slice(0, 8);
  return {
    title: options?.title ?? `Receta de prueba ${suffix}`,
    slug: options?.slug ?? `receta-de-prueba-${suffix}`,
    description: "Preparación paso a paso para verificación de integridad relacional.",
    prepTimeMinutes: options?.prepTimeMinutes ?? 30,
    ingredients: options?.ingredients ?? [{ name: "Harina", quantity: 500, unit: "g" }],
    authorId,
    ...(options?.nutritionalInfo !== undefined
      ? { nutritionalInfo: options.nutritionalInfo }
      : {}),
    ...(options?.reviewedById !== undefined ? { reviewedById: options.reviewedById } : {}),
    ...(options?.updatedAt !== undefined ? { updatedAt: options.updatedAt } : {}),
  };
}

describe("Integridad relacional PostgreSQL 15 — migración inicial", () => {
  const db = getDatabase();

  beforeEach(async () => {
    await truncateTables(db);
  });

  afterEach(async () => {
    await truncateTables(db);
  });

  afterAll(async () => {
    await disconnect();
  });

  describe("Catálogo de motor (extensión, COMMENT, FKs e índices)", () => {
    it("tiene instalada la extensión pgcrypto", async () => {
      // Act
      const rows = await db.prisma.$queryRaw<Array<{ extname: string }>>`
        SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'
      `;

      // Assert
      expect(rows).toEqual([{ extname: "pgcrypto" }]);
    });

    it("registra el COMMENT documental RN-06 sobre audit_logs.entityId", async () => {
      // Act
      const rows = await db.prisma.$queryRaw<Array<{ comment: string | null }>>`
        SELECT col_description('public.audit_logs'::regclass, attnum) AS comment
        FROM pg_attribute
        WHERE attrelid = 'public.audit_logs'::regclass
          AND attname = 'entityId'
          AND NOT attisdropped
      `;

      // Assert
      expect(rows).toHaveLength(1);
      expect(rows[0]?.comment).toContain("RN-06");
    });

    it("declara las FKs con RESTRICT/SET NULL, ON UPDATE NO ACTION y cero CASCADE", async () => {
      // Act
      const rows = await db.prisma.$queryRaw<
        Array<{ conname: string; confdeltype: string; confupdtype: string }>
      >`
        SELECT c.conname, c.confdeltype::text AS confdeltype, c.confupdtype::text AS confupdtype
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'public' AND c.contype = 'f'
        ORDER BY c.conname
      `;

      // Assert
      expect(rows).toEqual([
        { conname: "fk_audit_logs_user", confdeltype: "n", confupdtype: "a" },
        { conname: "fk_recipes_author", confdeltype: "r", confupdtype: "a" },
        { conname: "fk_recipes_reviewer", confdeltype: "n", confupdtype: "a" },
      ]);
    });

    it("declara los 6 índices B-Tree esperados sin índices duplicados sobre email ni slug", async () => {
      // Act
      const rows = await db.prisma.$queryRaw<Array<{ tablename: string; indexname: string }>>`
        SELECT tablename, indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename IN ('users', 'recipes', 'audit_logs')
        ORDER BY tablename, indexname
      `;

      // Assert
      expect(rows).toEqual([
        { tablename: "audit_logs", indexname: "audit_logs_pkey" },
        { tablename: "audit_logs", indexname: "idx_audit_logs_createdat" },
        { tablename: "audit_logs", indexname: "idx_audit_logs_entity" },
        { tablename: "audit_logs", indexname: "idx_audit_logs_userid" },
        { tablename: "recipes", indexname: "idx_recipes_authorid" },
        { tablename: "recipes", indexname: "idx_recipes_status_difficulty" },
        { tablename: "recipes", indexname: "recipes_pkey" },
        { tablename: "recipes", indexname: "recipes_slug_key" },
        { tablename: "users", indexname: "idx_users_role_isactive" },
        { tablename: "users", indexname: "users_email_key" },
        { tablename: "users", indexname: "users_pkey" },
      ]);
    });
  });

  describe("Unicidad (P2002) y ocultamiento de credenciales (omit)", () => {
    it("rechaza con P2002 al insertar un email duplicado en users", async () => {
      // Arrange
      const email = `duplicado-${randomUUID().slice(0, 8)}@recetaria.test`;
      await createUser(db, { email });

      // Act
      let caught: unknown;
      try {
        await createUser(db, { email });
      } catch (err: unknown) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      if (caught instanceof Prisma.PrismaClientKnownRequestError) {
        expect(caught.code).toBe("P2002");
      }
    });

    it("rechaza con P2002 al insertar un slug duplicado en recipes", async () => {
      // Arrange
      const author = await createUser(db);
      const slug = `empanadas-${randomUUID().slice(0, 8)}`;
      await db.prisma.recipe.create({ data: buildRecipeData(author.id, { slug }) });

      // Act
      let caught: unknown;
      try {
        await db.prisma.recipe.create({ data: buildRecipeData(author.id, { slug }) });
      } catch (err: unknown) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      if (caught instanceof Prisma.PrismaClientKnownRequestError) {
        expect(caught.code).toBe("P2002");
      }
    });

    it("excluye passwordHash en tiempo de ejecución en create, findUnique e include", async () => {
      // Arrange
      const created = await createUser(db);
      const reviewer = await createUser(db, { role: "CHEF" });
      const recipe = await db.prisma.recipe.create({
        data: buildRecipeData(created.id, { reviewedById: reviewer.id }),
      });

      // Act
      const foundUser = await db.prisma.user.findUnique({ where: { id: created.id } });
      const foundRecipe = await db.prisma.recipe.findUnique({
        where: { id: recipe.id },
        include: { author: true, reviewedBy: true },
      });

      // Assert
      expect("passwordHash" in created).toBe(false);
      expect(foundUser).not.toBeNull();
      if (foundUser !== null) {
        expect(foundUser.id).toBe(created.id);
        expect("passwordHash" in foundUser).toBe(false);
        expect(Object.keys(foundUser)).not.toContain("passwordHash");
      }
      expect(foundRecipe?.author).toBeDefined();
      if (foundRecipe !== null) {
        expect("passwordHash" in foundRecipe.author).toBe(false);
        expect(foundRecipe.reviewedBy).not.toBeNull();
        if (foundRecipe.reviewedBy !== null) {
          expect("passwordHash" in foundRecipe.reviewedBy).toBe(false);
        }
      }
    });
  });

  describe("Restricciones CHECK en PostgreSQL (SQLSTATE 23514)", () => {
    it.each([0, -5, 1441])(
      "rechaza prepTimeMinutes inválido (%i) con chk_prep_time_positive (RN-07)",
      async (prepTimeMinutes) => {
        // Arrange
        const author = await createUser(db);

        // Act & Assert
        await expectCheckViolation(
          () => db.prisma.recipe.create({ data: buildRecipeData(author.id, { prepTimeMinutes }) }),
          "chk_prep_time_positive",
        );
        expect(await db.prisma.recipe.count()).toBe(0);
      },
    );

    it.each([1, 1440])(
      "acepta prepTimeMinutes límite válido (%i) (RN-07)",
      async (prepTimeMinutes) => {
        // Arrange
        const author = await createUser(db);

        // Act
        const created = await db.prisma.recipe.create({
          data: buildRecipeData(author.id, { prepTimeMinutes }),
        });

        // Assert
        expect(created.prepTimeMinutes).toBe(prepTimeMinutes);
      },
    );

    it("rechaza auto-aprobación en INSERT cuando reviewedById === authorId (RN-05)", async () => {
      // Arrange
      const chef = await createUser(db, { role: "CHEF" });

      // Act & Assert
      await expectCheckViolation(
        () =>
          db.prisma.recipe.create({
            data: buildRecipeData(chef.id, { reviewedById: chef.id }),
          }),
        "chk_recipes_reviewer_not_author",
      );
    });

    it("rechaza auto-aprobación en UPDATE cuando reviewedById === authorId (RN-05)", async () => {
      // Arrange
      const chef = await createUser(db, { role: "CHEF" });
      const recipe = await db.prisma.recipe.create({ data: buildRecipeData(chef.id) });

      // Act & Assert
      await expectCheckViolation(
        () =>
          db.prisma.recipe.update({
            where: { id: recipe.id },
            data: { reviewedById: chef.id },
          }),
        "chk_recipes_reviewer_not_author",
      );

      const persisted = await db.prisma.recipe.findUnique({ where: { id: recipe.id } });
      expect(persisted?.reviewedById).toBeNull();
    });

    it("rechaza ingredients cuando no es un array JSONB", async () => {
      // Arrange
      const author = await createUser(db);

      // Act & Assert
      await expectCheckViolation(
        () =>
          db.prisma.recipe.create({
            data: buildRecipeData(author.id, {
              ingredients: { name: "Sal", quantity: 10, unit: "g" },
            }),
          }),
        "chk_recipes_ingredients_array",
      );
    });

    it("rechaza nutritionalInfo cuando es un array JSONB", async () => {
      // Arrange
      const author = await createUser(db);

      // Act & Assert
      await expectCheckViolation(
        () =>
          db.prisma.recipe.create({
            data: buildRecipeData(author.id, { nutritionalInfo: ["invalido"] }),
          }),
        "chk_recipes_nutritional_info_object",
      );
    });

    it("rechaza nutritionalInfo cuando se envía Prisma.JsonNull (JSON null)", async () => {
      // Arrange
      const author = await createUser(db);

      // Act & Assert
      await expectCheckViolation(
        () =>
          db.prisma.recipe.create({
            data: buildRecipeData(author.id, { nutritionalInfo: Prisma.JsonNull }),
          }),
        "chk_recipes_nutritional_info_object",
      );
    });

    it("acepta nutritionalInfo omitido al crear", async () => {
      // Arrange
      const author = await createUser(db);

      // Act
      const created = await db.prisma.recipe.create({
        data: buildRecipeData(author.id),
      });

      // Assert
      expect(created.nutritionalInfo).toBeNull();
    });

    it("permite limpiar nutritionalInfo a SQL NULL usando Prisma.DbNull", async () => {
      // Arrange
      const author = await createUser(db);
      const created = await db.prisma.recipe.create({
        data: buildRecipeData(author.id, {
          nutritionalInfo: { calories: 320, servings: 2 },
        }),
      });

      // Act
      const cleared = await db.prisma.recipe.update({
        where: { id: created.id },
        data: { nutritionalInfo: Prisma.DbNull },
      });

      // Assert
      expect(cleared.nutritionalInfo).toBeNull();
    });
  });

  describe("Triggers automáticos de updatedAt en PostgreSQL", () => {
    it("actualiza updatedAt en users mediante trigger BEFORE UPDATE sin @updatedAt", async () => {
      // Arrange
      const initialDate = new Date("2020-01-01T00:00:00.000Z");
      const user = await createUser(db, { updatedAt: initialDate });
      expect(user.updatedAt.getTime()).toBe(initialDate.getTime());

      // Act
      await db.prisma.$executeRaw`
        UPDATE "users" SET "firstName" = 'Actualizado' WHERE "id" = ${user.id}::uuid
      `;
      const updated = await db.prisma.user.findUniqueOrThrow({ where: { id: user.id } });

      // Assert
      expect(updated.firstName).toBe("Actualizado");
      expect(updated.updatedAt.getTime()).toBeGreaterThan(user.updatedAt.getTime());
    });

    it("actualiza updatedAt en recipes mediante trigger BEFORE UPDATE sin @updatedAt", async () => {
      // Arrange
      const initialDate = new Date("2020-01-01T00:00:00.000Z");
      const author = await createUser(db);
      const recipe = await db.prisma.recipe.create({
        data: buildRecipeData(author.id, { updatedAt: initialDate }),
      });
      expect(recipe.updatedAt.getTime()).toBe(initialDate.getTime());

      // Act
      await db.prisma.$executeRaw`
        UPDATE "recipes" SET "title" = 'Título actualizado' WHERE "id" = ${recipe.id}::uuid
      `;
      const updated = await db.prisma.recipe.findUniqueOrThrow({ where: { id: recipe.id } });

      // Assert
      expect(updated.title).toBe("Título actualizado");
      expect(updated.updatedAt.getTime()).toBeGreaterThan(recipe.updatedAt.getTime());
    });
  });

  describe("Políticas referenciales y trazabilidad RN-06", () => {
    it("ON DELETE RESTRICT impide eliminar un Autor con al menos una Receta asociada", async () => {
      // Arrange
      const author = await createUser(db);
      const recipe = await db.prisma.recipe.create({ data: buildRecipeData(author.id) });

      // Act
      let caught: unknown;
      try {
        await db.prisma.user.delete({ where: { id: author.id } });
      } catch (err: unknown) {
        caught = err;
      }

      // Assert
      expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      const info = inspectDbError(caught);
      expect(info.prismaCode).toBe("P2003");
      expect(info.kind).toBe("ForeignKeyConstraintViolation");
      expect(info.message).toContain("fk_recipes_author");

      const persistedAuthor = await db.prisma.user.findUnique({ where: { id: author.id } });
      const persistedRecipe = await db.prisma.recipe.findUnique({ where: { id: recipe.id } });
      expect(persistedAuthor?.id).toBe(author.id);
      expect(persistedRecipe?.id).toBe(recipe.id);
    });

    it("ON DELETE SET NULL conserva la Receta con reviewedById en null al eliminar el Revisor", async () => {
      // Arrange
      const author = await createUser(db);
      const reviewer = await createUser(db, { role: "CHEF" });
      const recipe = await db.prisma.recipe.create({
        data: buildRecipeData(author.id, { reviewedById: reviewer.id }),
      });

      // Act
      await db.prisma.user.delete({ where: { id: reviewer.id } });
      const persistedRecipe = await db.prisma.recipe.findUnique({ where: { id: recipe.id } });

      // Assert
      expect(persistedRecipe).not.toBeNull();
      expect(persistedRecipe?.reviewedById).toBeNull();
      expect(persistedRecipe?.authorId).toBe(author.id);
    });

    it("ON DELETE SET NULL conserva AuditLog con userId en null al eliminar al actor", async () => {
      // Arrange
      const actor = await createUser(db, { role: "ADMIN" });
      const targetEntityId = randomUUID();
      const log = await db.prisma.auditLog.create({
        data: {
          entityName: "Recipe",
          entityId: targetEntityId,
          action: "DELETE",
          userId: actor.id,
          oldValues: { title: "Sopa de calabaza", status: "DRAFT" },
        },
      });

      // Act
      await db.prisma.user.delete({ where: { id: actor.id } });
      const persistedLog = await db.prisma.auditLog.findUnique({ where: { id: log.id } });

      // Assert
      expect(persistedLog).not.toBeNull();
      expect(persistedLog?.userId).toBeNull();
      expect(persistedLog?.entityId).toBe(targetEntityId);
      expect(persistedLog?.action).toBe("DELETE");
    });

    it("conserva el AuditLog intacto tras eliminar físicamente la Receta referenciada (RN-06)", async () => {
      // Arrange
      const author = await createUser(db);
      const recipe = await db.prisma.recipe.create({
        data: buildRecipeData(author.id, { title: "Tarta de manzana" }),
      });
      const log = await db.prisma.auditLog.create({
        data: {
          entityName: "Recipe",
          entityId: recipe.id,
          action: "DELETE",
          userId: author.id,
          oldValues: {
            title: recipe.title,
            authorId: recipe.authorId,
            status: recipe.status,
          },
          newValues: Prisma.DbNull,
        },
      });

      // Act
      await db.prisma.recipe.delete({ where: { id: recipe.id } });

      // Assert
      const deletedRecipe = await db.prisma.recipe.findUnique({ where: { id: recipe.id } });
      const persistedLog = await db.prisma.auditLog.findUnique({ where: { id: log.id } });
      expect(deletedRecipe).toBeNull();
      expect(persistedLog).not.toBeNull();
      expect(persistedLog?.entityName).toBe("Recipe");
      expect(persistedLog?.entityId).toBe(recipe.id);
      expect(persistedLog?.action).toBe("DELETE");
      expect(persistedLog?.oldValues).toEqual({
        title: "Tarta de manzana",
        authorId: author.id,
        status: "DRAFT",
      });
      expect(persistedLog?.newValues).toBeNull();
    });
  });
});
