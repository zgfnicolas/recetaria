import type { Database } from "../../src/infrastructure/database/prisma.js";
import type { JwtConfig } from "../../src/modules/auth/index.js";

/** Configuración JWT compartida por las suites End-to-End (#22). Solo para pruebas. */
export const E2E_JWT_CONFIG: JwtConfig = Object.freeze({
  secret: "test-jwt-secret-".repeat(3),
  expiresIn: "1h",
});

/** Limpieza entre pruebas: vacía las 3 tablas en una sola sentencia (respeta las FK). */
export async function truncateAll(db: Database): Promise<void> {
  await db.prisma.$executeRaw`TRUNCATE TABLE "audit_logs", "recipes", "users" RESTART IDENTITY;`;
}
