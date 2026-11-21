import path from "node:path";
import { fileURLToPath } from "node:url";
import * as bcrypt from "bcrypt";
import { config as loadEnv } from "dotenv";
import type { Role } from "../src/generated/prisma/client.js";
import {
  disconnect,
  getDatabase,
  type AppPrismaClient,
  type Database,
} from "../src/infrastructure/database/prisma.js";

export const DEFAULT_SEED_PASSWORD = "password123";
export const BCRYPT_SALT_ROUNDS = 10;
const MAX_BCRYPT_SALT_ROUNDS = 31;
const MAX_BCRYPT_PASSWORD_BYTES = 72;
const ALLOWED_SEED_ENVS = new Set(["development", "test"]);

export type SeedUserDefinition = {
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly role: Role;
  readonly isActive: true;
};

export const SEED_USERS: readonly SeedUserDefinition[] = [
  {
    email: "user@recetaria.com",
    firstName: "Usuario",
    lastName: "Prueba",
    role: "USER",
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
    email: "admin@recetaria.com",
    firstName: "Admin",
    lastName: "Sistema",
    role: "ADMIN",
    isActive: true,
  },
] as const;

export type SeedUsersOptions = {
  readonly password?: string | undefined;
  readonly saltRounds?: number | undefined;
};

export type SeedUsersResult = {
  readonly insertedCount: number;
  readonly totalExpected: number;
};

/**
 * Inserta de forma atómica e idempotente los 4 usuarios semilla RBAC (ON CONFLICT DO NOTHING).
 * Genera un hash Bcrypt independiente por usuario con >= 10 salt rounds (RN-08).
 */
export async function seedUsers(
  prisma: AppPrismaClient,
  options?: SeedUsersOptions,
): Promise<SeedUsersResult> {
  const password = options?.password ?? DEFAULT_SEED_PASSWORD;
  if (password.trim() === "") {
    throw new Error("La contraseña semilla no puede estar vacía");
  }
  if (Buffer.byteLength(password, "utf8") > MAX_BCRYPT_PASSWORD_BYTES) {
    throw new Error(`La contraseña semilla no puede superar ${MAX_BCRYPT_PASSWORD_BYTES} bytes`);
  }

  const saltRounds = options?.saltRounds ?? BCRYPT_SALT_ROUNDS;
  if (
    !Number.isInteger(saltRounds) ||
    saltRounds < BCRYPT_SALT_ROUNDS ||
    saltRounds > MAX_BCRYPT_SALT_ROUNDS
  ) {
    throw new Error(
      `saltRounds debe ser un entero entre ${BCRYPT_SALT_ROUNDS} y ${MAX_BCRYPT_SALT_ROUNDS} (RN-08)`,
    );
  }

  const data = await Promise.all(
    SEED_USERS.map(async (user) => ({
      email: user.email,
      passwordHash: await bcrypt.hash(password, saltRounds),
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      isActive: user.isActive,
    })),
  );

  const { count } = await prisma.user.createMany({
    data,
    skipDuplicates: true,
  });

  return {
    insertedCount: count,
    totalExpected: SEED_USERS.length,
  };
}

export type SeedLogger = {
  info(message: string): void;
};

export type RunSeedOptions = {
  readonly nodeEnv?: string | undefined;
  readonly createDb?: (() => Database) | undefined;
  readonly closeDb?: ((db: Database) => Promise<void>) | undefined;
  readonly logger?: SeedLogger | undefined;
  readonly seedOptions?: SeedUsersOptions | undefined;
};

/**
 * Orquesta el seed CLI aplicando allowlist fail-closed (solo development/test)
 * y cierre ordenado del cliente Prisma + pg.Pool tanto en éxito como ante error.
 */
export async function runSeed(options?: RunSeedOptions): Promise<SeedUsersResult> {
  const rawNodeEnv = options?.nodeEnv ?? process.env["NODE_ENV"];
  const normalizedEnv = rawNodeEnv?.trim().toLowerCase();
  if (normalizedEnv === undefined || !ALLOWED_SEED_ENVS.has(normalizedEnv)) {
    throw new Error(
      `Seed de desarrollo habilitado solo en NODE_ENV=development|test (recibido: "${rawNodeEnv ?? ""}")`,
    );
  }

  const logger = options?.logger ?? {
    info: (message: string) => {
      console.log(message);
    },
  };

  const createDb = options?.createDb;
  const db = createDb !== undefined ? createDb() : getDatabase();
  const closeDb =
    options?.closeDb ??
    (createDb !== undefined ? async (instance: Database) => instance.disconnect() : async () => disconnect());

  try {
    const result = await seedUsers(db.prisma, options?.seedOptions);
    logger.info(
      `[seed] Completado: ${result.insertedCount} usuarios creados (${result.totalExpected} perfiles RBAC asegurados).`,
    );
    return result;
  } finally {
    await closeDb(db);
  }
}

function isMainModule(): boolean {
  const entryArg = process.argv[1];
  if (entryArg === undefined) {
    return false;
  }
  return path.resolve(entryArg) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  loadEnv({ quiet: true });
  runSeed().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : "Error desconocido al ejecutar seed";
    console.error(`[seed] Error: ${message}`);
    process.exitCode = 1;
  });
}
