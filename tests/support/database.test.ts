import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { disconnect, getDatabase } from "../../src/infrastructure/database/prisma.js";
import { truncateAll } from "./database.js";

describe("truncateAll — guarda contra el borrado de una base que no es de pruebas", () => {
  const db = getDatabase();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("las pruebas corren contra una base <base>_test, nunca contra la de DATABASE_URL de desarrollo", async () => {
    // Act
    const [row] = await db.prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;

    // Assert
    expect(row?.name).toMatch(/_test$/);
    expect(process.env["DATABASE_URL"]).toMatch(/_test(?:\?|$)/);
  });

  it("vacía las tablas cuando la conexión es de pruebas", async () => {
    // Arrange — primero la limpieza con guarda: ninguna escritura antes de verificar la base
    await truncateAll(db);
    await db.prisma.user.create({
      data: { email: "guarda@recetaria.com", passwordHash: "x", firstName: "G", lastName: "T" },
    });

    // Act
    await truncateAll(db);

    // Assert
    expect(await db.prisma.user.count()).toBe(0);
  });

  it("se niega a borrar si la conexión apunta a una base sin sufijo _test (y no ejecuta el TRUNCATE)", async () => {
    // Arrange — simula una conexión a la base de desarrollo
    vi.spyOn(db.prisma, "$queryRaw").mockResolvedValueOnce([{ name: "recetaria" }]);
    const execute = vi.spyOn(db.prisma, "$executeRaw");
    const executeUnsafe = vi.spyOn(db.prisma, "$executeRawUnsafe");
    const transaction = vi.spyOn(db.prisma, "$transaction");

    // Act & Assert — ningún camino de escritura se ejecuta
    await expect(truncateAll(db)).rejects.toThrow(/termine en "_test"/);
    expect(execute).not.toHaveBeenCalled();
    expect(executeUnsafe).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
