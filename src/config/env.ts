import { config as dotenvConfig } from "dotenv";
import { z } from "zod";

/** Entornos de ejecución soportados por Recetaria API. */
export const NODE_ENVS = ["development", "test", "production"] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];

/** Unidades válidas (en segundos o superiores) compatibles con jsonwebtoken (`ms`). */
export type JwtDurationUnit = "s" | "m" | "h" | "d" | "w" | "y";

/** Expresión de expiración JWT compatible con `ms.StringValue`. */
export type JwtExpiresIn = `${number}${JwtDurationUnit}`;

export type EnvSource = Readonly<Record<string, string | undefined>>;

export type LoadEnvOptions = Readonly<{
  loadDotenv?: boolean | undefined;
}>;

const JWT_EXPIRES_IN_PATTERN = /^[1-9]\d{0,5}(s|m|h|d|w|y)$/;

function isJwtExpiresIn(value: string): value is JwtExpiresIn {
  return JWT_EXPIRES_IN_PATTERN.test(value);
}

function hasPostgresHostAndDatabase(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname.length > 0 && parsed.pathname.slice(1).trim().length > 0;
  } catch {
    return false;
  }
}

const envSchema = z.object({
  NODE_ENV: z
    .enum(NODE_ENVS, { error: "NODE_ENV debe ser development, test o production" })
    .default("development"),
  PORT: z
    .string({ error: "PORT debe ser un número entero entre 1 y 65535" })
    .trim()
    .regex(/^\d+$/, { error: "PORT debe ser un número entero entre 1 y 65535" })
    .transform((value) => Number.parseInt(value, 10))
    .pipe(
      z
        .number()
        .int()
        .min(1, { error: "PORT debe ser mayor o igual a 1" })
        .max(65_535, { error: "PORT debe ser menor o igual a 65535" }),
    )
    .default(3000),
  DATABASE_URL: z
    .url({
      protocol: /^postgres(ql)?$/,
      error: "DATABASE_URL debe ser una URL válida de PostgreSQL (postgres:// o postgresql://)",
    })
    .refine(hasPostgresHostAndDatabase, {
      error: "DATABASE_URL debe incluir host y nombre de base de datos",
    }),
  JWT_SECRET: z
    .string({ error: "JWT_SECRET es obligatorio" })
    .min(32, { error: "JWT_SECRET debe tener al menos 32 caracteres" })
    .refine((value) => value.replace(/\s+/g, "").length >= 32, {
      error: "JWT_SECRET debe contener al menos 32 caracteres distintos de espacios",
    }),
  JWT_EXPIRES_IN: z
    .string({ error: "JWT_EXPIRES_IN debe ser una duración válida" })
    .trim()
    .refine(isJwtExpiresIn, {
      error:
        "JWT_EXPIRES_IN debe tener formato válido con unidad explícita (ej.: 15m, 1h, 1d, 3600s)",
    })
    .default("1d"),
});

/** Configuración de entorno validada e inmutable en tiempo de compilación. */
export type Env = Readonly<z.infer<typeof envSchema>>;

/**
 * Valida un diccionario de variables de entorno bajo esquema estricto Zod 4 (fail fast).
 * Nunca expone valores de secretos ni credenciales en el mensaje de error.
 */
export function parseEnv(source: EnvSource): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Configuración de entorno inválida: ${problems}`);
  }

  return Object.freeze(result.data);
}

/**
 * Carga variables locales vía dotenv (opcional) y valida `process.env` fail fast.
 */
export function loadEnv(options?: LoadEnvOptions): Env {
  if (options?.loadDotenv ?? true) {
    dotenvConfig({ quiet: true });
  }
  return parseEnv(process.env);
}
