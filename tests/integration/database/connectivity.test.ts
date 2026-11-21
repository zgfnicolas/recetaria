import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createDatabase,
  disconnect,
  getDatabase,
  type Database,
} from "../../../src/infrastructure/database/prisma.js";

function requireDatabaseUrl(): string {
  const url = process.env["DATABASE_URL"]?.trim();
  if (url === undefined || url === "") {
    throw new Error("DATABASE_URL es obligatoria para ejecutar las pruebas de integración");
  }
  return url;
}

describe("Persistencia Prisma 7 + PrismaPg — conectividad PostgreSQL 15", () => {
  afterEach(async () => {
    await disconnect();
  });

  it("ejecuta SELECT 1 correctamente a través de PrismaPg", async () => {
    // Arrange
    const db = createDatabase(requireDatabaseUrl());

    try {
      // Act
      const rows = await db.prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1::int AS ok`;

      // Assert
      expect(rows).toEqual([{ ok: 1 }]);
    } finally {
      await db.disconnect();
    }
  });

  it("se conecta contra un servidor PostgreSQL 15", async () => {
    // Arrange
    const db = createDatabase(requireDatabaseUrl());

    try {
      // Act
      const [row] = await db.prisma.$queryRaw<Array<{ versionNum: number }>>`
        SELECT current_setting('server_version_num')::int AS "versionNum"
      `;

      // Assert
      expect(row?.versionNum).toBeGreaterThanOrEqual(150000);
      expect(row?.versionNum).toBeLessThan(160000);
    } finally {
      await db.disconnect();
    }
  });

  it("disconnect() cierra Prisma y el pool pg sin dejar conexiones activas", async () => {
    // Arrange
    const db = createDatabase(requireDatabaseUrl());

    try {
      await db.prisma.$queryRaw`SELECT 1`;
      expect(db.pool.totalCount).toBeGreaterThan(0);

      // Act
      await db.disconnect();

      // Assert
      expect(db.pool.ended).toBe(true);
      expect(db.pool.totalCount).toBe(0);
    } finally {
      await db.disconnect();
    }
  });

  it("disconnect() es idempotente incluso ante llamadas concurrentes", async () => {
    // Arrange
    const db = createDatabase(requireDatabaseUrl());

    try {
      await db.prisma.$queryRaw`SELECT 1`;
      expect(db.pool.totalCount).toBeGreaterThan(0);

      // Act
      await Promise.all([db.disconnect(), db.disconnect()]);
      await expect(db.disconnect()).resolves.toBeUndefined();

      // Assert
      expect(db.pool.ended).toBe(true);
      expect(db.pool.totalCount).toBe(0);
    } finally {
      await db.disconnect();
    }
  });

  it("getDatabase() reutiliza el singleton y permite reinicializar tras disconnect()", async () => {
    // Arrange & Act
    const first = getDatabase();
    const second = getDatabase();

    try {
      expect(second).toBe(first);
      const rows = await first.prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1::int AS ok`;
      expect(rows).toEqual([{ ok: 1 }]);
    } finally {
      await disconnect();
    }

    expect(first.pool.ended).toBe(true);
    expect(first.pool.totalCount).toBe(0);

    const third = getDatabase();
    try {
      expect(third).not.toBe(first);
      expect(third.pool.ended).toBe(false);
      const rows = await third.prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1::int AS ok`;
      expect(rows).toEqual([{ ok: 1 }]);
    } finally {
      await disconnect();
    }

    expect(third.pool.ended).toBe(true);
  });

  it("rechaza fail-fast cuando createDatabase() recibe una cadena vacía", () => {
    // Act & Assert
    expect(() => createDatabase("   ")).toThrow("DATABASE_URL no puede estar vacía");
  });

  it("rechaza fail-fast cuando getDatabase() se invoca sin DATABASE_URL", async () => {
    // Arrange
    await disconnect();
    vi.stubEnv("DATABASE_URL", "");

    // Act & Assert
    expect(() => getDatabase()).toThrow("DATABASE_URL no está definida");
  });

  it("excluye passwordHash del tipo de retorno por defecto de User (omit)", () => {
    type DefaultUser = NonNullable<
      Awaited<ReturnType<Database["prisma"]["user"]["findFirst"]>>
    >;

    expectTypeOf<DefaultUser>().toHaveProperty("id");
    expectTypeOf<DefaultUser>().toHaveProperty("email");
    expectTypeOf<DefaultUser>().not.toHaveProperty("passwordHash");
  });

  it("falla al intentar consultar con credenciales inválidas (control de sensibilidad)", async () => {
    // Arrange
    const badUrl = new URL(requireDatabaseUrl());
    badUrl.password = "credencial-invalida-test";
    const db = createDatabase(badUrl.toString());

    try {
      // Act & Assert
      await expect(db.prisma.$queryRaw`SELECT 1`).rejects.toThrow(Error);
    } finally {
      await db.disconnect();
    }
  });
});
