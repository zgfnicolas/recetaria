import * as bcrypt from "bcrypt";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runSeed,
  seedUsers,
  type SeedLogger,
} from "../../../prisma/seed.js";
import {
  createDatabase,
  disconnect,
  getDatabase,
  type Database,
} from "../../../src/infrastructure/database/prisma.js";
import { truncateAll } from "../../support/database.js";

const EXPECTED_SEED_PROFILES = [
  {
    email: "admin@recetaria.com",
    firstName: "Admin",
    lastName: "Sistema",
    role: "ADMIN",
    isActive: true,
  },
  {
    email: "chef@recetaria.com",
    firstName: "Chef",
    lastName: "Validador",
    role: "CHEF",
    isActive: true,
  },
  {
    email: "nutri@recetaria.com",
    firstName: "Nutricionista",
    lastName: "Clinico",
    role: "NUTRITIONIST",
    isActive: true,
  },
  {
    email: "user@recetaria.com",
    firstName: "Usuario",
    lastName: "Prueba",
    role: "USER",
    isActive: true,
  },
] as const;

const KNOWN_DEV_PASSWORD = "password123";
const MIN_BCRYPT_ROUNDS = 10;

function requireDatabaseUrl(): string {
  const url = process.env["DATABASE_URL"]?.trim();
  if (url === undefined || url === "") {
    throw new Error("DATABASE_URL es obligatoria para ejecutar las pruebas de integración");
  }
  return url;
}

async function truncateTables(db: Database): Promise<void> {
  await truncateAll(db);
}

describe("Seed idempotente de usuarios RBAC — PostgreSQL 15", () => {
  let db: Database;

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

  it("crea los 4 perfiles RBAC con isActive = true y omite passwordHash por defecto", async () => {
    // Arrange
    expect(await db.prisma.user.count()).toBe(0);

    // Act
    const result = await seedUsers(db.prisma);

    // Assert
    const persisted = await db.prisma.user.findMany({ orderBy: { email: "asc" } });
    expect(result).toEqual({ insertedCount: 4, totalExpected: 4 });
    expect(persisted).toHaveLength(4);
    expect(
      persisted.map((user) => ({
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        isActive: user.isActive,
      })),
    ).toEqual(EXPECTED_SEED_PROFILES);

    for (const user of persisted) {
      expect("passwordHash" in user).toBe(false);
    }
  });

  it("almacena contraseñas hasheadas con Bcrypt >= 10 rounds y salts únicos (RN-08)", async () => {
    // Arrange
    await seedUsers(db.prisma);

    // Act
    const usersWithHash = await db.prisma.user.findMany({
      omit: { passwordHash: false },
      orderBy: { email: "asc" },
    });

    // Assert
    expect(usersWithHash).toHaveLength(4);
    const uniqueHashes = new Set<string>();

    for (const user of usersWithHash) {
      expect(user.passwordHash).not.toBe(KNOWN_DEV_PASSWORD);
      expect(bcrypt.getRounds(user.passwordHash)).toBeGreaterThanOrEqual(MIN_BCRYPT_ROUNDS);
      expect(await bcrypt.compare(KNOWN_DEV_PASSWORD, user.passwordHash)).toBe(true);
      expect(await bcrypt.compare("clave-incorrecta", user.passwordHash)).toBe(false);
      uniqueHashes.add(user.passwordHash);
    }

    expect(uniqueHashes.size).toBe(4);
  });

  it("rechaza fail-fast contraseña vacía, > 72 bytes o saltRounds fuera de rango [10..31]", async () => {
    // Arrange
    const overlongPassword = "a".repeat(73);

    // Act & Assert
    await expect(seedUsers(db.prisma, { password: "   " })).rejects.toThrow(
      "La contraseña semilla no puede estar vacía",
    );
    await expect(seedUsers(db.prisma, { password: overlongPassword })).rejects.toThrow(
      "72 bytes",
    );
    await expect(seedUsers(db.prisma, { saltRounds: 9 })).rejects.toThrow("saltRounds");
    await expect(seedUsers(db.prisma, { saltRounds: 32 })).rejects.toThrow("saltRounds");
    await expect(seedUsers(db.prisma, { saltRounds: 10.5 })).rejects.toThrow("saltRounds");
    expect(await db.prisma.user.count()).toBe(0);
  });

  it("es idempotente ante ejecuciones secuenciales sin duplicar ni mutar filas existentes", async () => {
    // Arrange
    const firstRun = await seedUsers(db.prisma);
    const snapshotBefore = await db.prisma.user.findMany({
      omit: { passwordHash: false },
      orderBy: { email: "asc" },
    });

    // Act
    const secondRun = await seedUsers(db.prisma);

    // Assert
    const snapshotAfter = await db.prisma.user.findMany({
      omit: { passwordHash: false },
      orderBy: { email: "asc" },
    });
    expect(firstRun).toEqual({ insertedCount: 4, totalExpected: 4 });
    expect(secondRun).toEqual({ insertedCount: 0, totalExpected: 4 });
    expect(snapshotAfter).toEqual(snapshotBefore);
  });

  it("preserva registros preexistentes cuando solo faltan algunos perfiles semilla", async () => {
    // Arrange
    const customHash = await bcrypt.hash("otra-clave-previa", MIN_BCRYPT_ROUNDS);
    const preexisting = await db.prisma.user.create({
      data: {
        email: "user@recetaria.com",
        passwordHash: customHash,
        firstName: "Existente",
        lastName: "Previo",
        role: "USER",
        isActive: true,
      },
    });

    // Act
    const result = await seedUsers(db.prisma);

    // Assert
    expect(result).toEqual({ insertedCount: 3, totalExpected: 4 });
    expect(await db.prisma.user.count()).toBe(4);
    const persisted = await db.prisma.user.findUniqueOrThrow({
      where: { id: preexisting.id },
      omit: { passwordHash: false },
    });
    expect(persisted.firstName).toBe("Existente");
    expect(persisted.passwordHash).toBe(customHash);
  });

  it("es idempotente ante ejecuciones concurrentes sin errores P2002 y conserva los 4 roles", async () => {
    // Arrange
    expect(await db.prisma.user.count()).toBe(0);

    // Act
    const [runA, runB] = await Promise.all([seedUsers(db.prisma), seedUsers(db.prisma)]);

    // Assert
    const persisted = await db.prisma.user.findMany({ orderBy: { role: "asc" } });
    expect(runA.insertedCount + runB.insertedCount).toBe(4);
    expect(persisted).toHaveLength(4);
    expect(persisted.map((user) => user.role)).toEqual([
      "USER",
      "CHEF",
      "NUTRITIONIST",
      "ADMIN",
    ]);
  });

  it.each(["production", "PRODUCTION", "staging", "", undefined])(
    "bloquea fail-closed runSeed cuando NODE_ENV es %s sin abrir conexiones",
    async (envValue) => {
      // Arrange
      vi.stubEnv("NODE_ENV", envValue ?? "");
      const createDb = vi.fn(() => createDatabase(requireDatabaseUrl()));

      // Act & Assert
      await expect(runSeed({ createDb })).rejects.toThrow("NODE_ENV=development|test");
      expect(createDb).not.toHaveBeenCalled();
    },
  );

  it("runSeed cierra Prisma y pg.Pool en éxito sin exponer contraseñas ni hashes en logs", async () => {
    // Arrange
    const customDb = createDatabase(requireDatabaseUrl());
    const infoMessages: string[] = [];
    const logger: SeedLogger = {
      info: (message: string) => {
        infoMessages.push(message);
      },
    };

    // Act
    const result = await runSeed({
      nodeEnv: "test",
      createDb: () => customDb,
      logger,
    });

    // Assert
    expect(result).toEqual({ insertedCount: 4, totalExpected: 4 });
    expect(customDb.pool.ended).toBe(true);
    expect(customDb.pool.totalCount).toBe(0);
    expect(infoMessages).toHaveLength(1);

    const combinedLogs = infoMessages.join("\n");
    expect(combinedLogs).toContain("4 usuarios creados");
    expect(combinedLogs).not.toContain(KNOWN_DEV_PASSWORD);
    expect(combinedLogs).not.toContain("$2b$");
  });

  it("runSeed cierra Prisma y pg.Pool limpiamente ante fallo sin exponer la credencial", async () => {
    // Arrange
    const badSecret = "credencial-invalida-seed";
    const badUrl = new URL(requireDatabaseUrl());
    badUrl.password = badSecret;
    const customDb = createDatabase(badUrl.toString());
    const info = vi.fn();

    // Act
    let caught: unknown;
    try {
      await runSeed({
        nodeEnv: "test",
        createDb: () => customDb,
        logger: { info },
      });
    } catch (err: unknown) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).not.toContain(badSecret);
    }
    expect(info).not.toHaveBeenCalled();
    expect(customDb.pool.ended).toBe(true);
    expect(customDb.pool.totalCount).toBe(0);
  });
});
