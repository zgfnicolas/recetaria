import "dotenv/config";
import { defineConfig } from "prisma/config";

const datasourceUrl =
  process.env.MIGRATION_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  // Se omite datasource cuando no hay URL definida para permitir comandos offline
  // (validate/format/generate) sin variables de entorno y cumplir exactOptionalPropertyTypes.
  // En producción/staging, MIGRATION_DATABASE_URL apunta a un rol DDL dedicado.
  ...(datasourceUrl ? { datasource: { url: datasourceUrl } } : {}),
});
