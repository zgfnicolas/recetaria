import type { Database } from "../../src/infrastructure/database/prisma.js";
import { assertTestDatabaseName } from "./test-database.js";

/**
 * Único punto de borrado de datos en las pruebas: vacía las 3 tablas en una sola sentencia
 * (respeta las FK). Defensa en profundidad: consulta en vivo a qué base está conectado y se niega
 * a borrar si no es una base `_test`, aunque una suite construya su propia conexión.
 */
export async function truncateAll(db: Database): Promise<void> {
  const [row] = await db.prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  assertTestDatabaseName(row?.name ?? "");
  await db.prisma.$executeRaw`TRUNCATE TABLE "audit_logs", "recipes", "users" RESTART IDENTITY;`;
}
