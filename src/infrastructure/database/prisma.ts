import pg from "pg";
import type { PoolConfig } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";

/**
 * Límites y timeouts explícitos del pool PostgreSQL (presupuesto de conexiones).
 */
const POOL_LIMITS = {
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 5_000,
  query_timeout: 10_000,
  idle_in_transaction_session_timeout: 10_000,
} as const satisfies PoolConfig;

function buildPrismaClient(adapter: PrismaPg) {
  return new PrismaClient({
    adapter,
    omit: {
      user: {
        passwordHash: true,
      },
    },
  });
}

export type AppPrismaClient = ReturnType<typeof buildPrismaClient>;

export type Database = {
  readonly prisma: AppPrismaClient;
  readonly pool: pg.Pool;
  disconnect(): Promise<void>;
};

/**
 * Fábrica pura de instancia de persistencia.
 * Permite pruebas aisladas y wiring desde el composition root.
 */
export function createDatabase(connectionString: string): Database {
  const normalizedUrl = connectionString.trim();
  if (normalizedUrl === "") {
    throw new Error("DATABASE_URL no puede estar vacía");
  }

  const pool = new pg.Pool({
    connectionString: normalizedUrl,
    ...POOL_LIMITS,
  });

  // Evita crash del proceso ante desconexiones inesperadas de clientes inactivos sin exponer credenciales.
  pool.on("error", (err: Error) => {
    console.error("[db] error en cliente inactivo del pool:", err.message);
  });

  const adapter = new PrismaPg(pool);
  const prisma = buildPrismaClient(adapter);

  let closing: Promise<void> | undefined;

  async function disconnect(): Promise<void> {
    closing ??= (async (): Promise<void> => {
      try {
        await prisma.$disconnect();
      } finally {
        // PrismaPg mantiene disposeExternalPool=false por defecto; cerramos el pool explícitamente.
        await pool.end();
      }
    })();

    return closing;
  }

  return { prisma, pool, disconnect };
}

function readDatabaseUrl(): string {
  const url = process.env["DATABASE_URL"]?.trim();
  if (url === undefined || url === "") {
    throw new Error("DATABASE_URL no está definida");
  }
  return url;
}

let singleton: Database | undefined;

/**
 * Devuelve el singleton por proceso (inicialización perezosa en el primer uso).
 */
export function getDatabase(): Database {
  singleton ??= createDatabase(readDatabaseUrl());
  return singleton;
}

/**
 * Cierra ordenadamente el cliente Prisma y el pool del singleton activo.
 */
export async function disconnect(): Promise<void> {
  const current = singleton;
  singleton = undefined;
  if (current !== undefined) {
    await current.disconnect();
  }
}
