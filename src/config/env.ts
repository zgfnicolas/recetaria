import { isIP } from "node:net";
import { config as dotenvConfig } from "dotenv";
import { z } from "zod";
import {
  hasValidJwtExpiresInFormat,
  isAllowedJwtExpiresIn,
  JWT_EXPIRES_IN_FORMAT_MESSAGE,
  JWT_EXPIRES_IN_MAX_MESSAGE,
} from "./jwt-expires-in.js";

/** Entornos de ejecución soportados por Recetaria API. */
export const NODE_ENVS = ["development", "test", "production"] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];

export type { JwtDurationUnit, JwtExpiresIn } from "./jwt-expires-in.js";

export type EnvSource = Readonly<Record<string, string | undefined>>;

export type LoadEnvOptions = Readonly<{
  loadDotenv?: boolean | undefined;
}>;

/** Máximo de saltos de proxy configurables en `TRUST_PROXY`. */
export const MAX_TRUST_PROXY_HOPS = 10;

/** Presets de subredes de `proxy-addr` aceptados por Express en `trust proxy`. */
export const TRUST_PROXY_PRESETS = ["loopback", "linklocal", "uniquelocal"] as const;

/**
 * Valor de `trust proxy` compatible con Express: número de saltos (`0` = no confiar)
 * o lista normalizada de IPs, rangos CIDR y presets separados por coma.
 */
export type TrustProxySetting = number | string;

/**
 * Prefijos CIDR mínimos de `TRUST_PROXY`: un rango más amplio confía en demasiados clientes
 * (`0.0.0.0/1`, `0.0.0.0/1,128.0.0.0/1`, `::/0`, `::ffff:0:0/96`) y equivale en la práctica
 * a `trust proxy: true`. `/8` admite una red privada clásica (`10.0.0.0/8`).
 */
export const MIN_TRUST_PROXY_IPV4_PREFIX = 8;
export const MIN_TRUST_PROXY_IPV6_PREFIX = 16;

const TRUST_PROXY_HOPS_PATTERN = /^\d+$/;
const CIDR_PREFIX_PATTERN = /^\d{1,3}$/;
const IPV4_MAPPED_IPV6_PATTERN = /^\[::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}\]$/;
const IPV4_MAPPED_PREFIX_OFFSET = 96;
const TRUST_PROXY_PRESET_SET: ReadonlySet<string> = new Set(TRUST_PROXY_PRESETS);

/** Detecta IPv4 mapeado en IPv6 en cualquier notación (`::ffff:0:0`, `::ffff:1.2.3.4`, expandida). */
function isIpv4MappedIpv6(address: string): boolean {
  const [withoutZone = ""] = address.split("%");
  try {
    return IPV4_MAPPED_IPV6_PATTERN.test(new URL(`http://[${withoutZone}]`).hostname);
  } catch {
    return false;
  }
}

/**
 * Rango demasiado amplio para confiar en él. `proxy-addr` (Express) convierte `::ffff:x/p`
 * con `p >= 96` al rango IPv4 `x/(p - 96)`: se evalúa por ese prefijo IPv4 efectivo.
 * Precondición: la entrada ya pasó `isValidTrustedProxyEntry`.
 */
function isOverlyBroadRange(entry: string): boolean {
  const [address = "", prefix] = entry.split("/");
  if (prefix === undefined) {
    return false;
  }

  const bits = Number(prefix);
  if (isIP(address) === 4) {
    return bits < MIN_TRUST_PROXY_IPV4_PREFIX;
  }
  if (bits >= IPV4_MAPPED_PREFIX_OFFSET && isIpv4MappedIpv6(address)) {
    return bits - IPV4_MAPPED_PREFIX_OFFSET < MIN_TRUST_PROXY_IPV4_PREFIX;
  }
  return bits < MIN_TRUST_PROXY_IPV6_PREFIX;
}

/** Valida una entrada de la lista: preset, IP (v4/v6) o rango CIDR con prefijo válido. */
function isValidTrustedProxyEntry(entry: string): boolean {
  if (TRUST_PROXY_PRESET_SET.has(entry)) {
    return true;
  }

  const parts = entry.split("/");
  const [address, prefix] = parts;
  if (address === undefined || parts.length > 2) {
    return false;
  }

  const version = isIP(address);
  if (version === 0) {
    return false;
  }
  if (prefix === undefined) {
    return true;
  }
  if (!CIDR_PREFIX_PATTERN.test(prefix)) {
    return false;
  }
  return Number(prefix) <= (version === 4 ? 32 : 128);
}

/**
 * `TRUST_PROXY` (#38): en qué proxies confiar para leer la IP real del cliente
 * desde `X-Forwarded-For` (rate limit por IP). Vacío o ausente → `0` (no confiar).
 * Rechaza `true`/`false` y rangos más amplios que `/8` (IPv4) o `/16` (IPv6): permitirían a
 * cualquier cliente falsificar su IP y evadir el límite.
 */
const trustProxySchema = z
  .string({ error: "TRUST_PROXY debe ser un texto" })
  .optional()
  .transform((raw, ctx): TrustProxySetting => {
    const value = raw?.trim() ?? "";
    if (value === "") {
      return 0;
    }

    if (value.toLowerCase() === "true" || value.toLowerCase() === "false") {
      ctx.issues.push({
        code: "custom",
        input: raw,
        message:
          "TRUST_PROXY no admite true/false: usá un número de saltos (0 = desactivado) o una lista de IPs/CIDR (true permite falsificar X-Forwarded-For)",
      });
      return z.NEVER;
    }

    if (TRUST_PROXY_HOPS_PATTERN.test(value)) {
      const hops = Number(value);
      if (hops > MAX_TRUST_PROXY_HOPS) {
        ctx.issues.push({
          code: "custom",
          input: raw,
          message: `TRUST_PROXY admite como máximo ${String(MAX_TRUST_PROXY_HOPS)} saltos de proxy`,
        });
        return z.NEVER;
      }
      return hops;
    }

    const entries = value.split(",").map((entry) => entry.trim());
    if (!entries.every(isValidTrustedProxyEntry)) {
      ctx.issues.push({
        code: "custom",
        input: raw,
        message: `TRUST_PROXY debe ser un número de saltos (0-${String(MAX_TRUST_PROXY_HOPS)}) o una lista de IPs, rangos CIDR o presets (${TRUST_PROXY_PRESETS.join(", ")}) separados por coma`,
      });
      return z.NEVER;
    }
    if (entries.some(isOverlyBroadRange)) {
      ctx.issues.push({
        code: "custom",
        input: raw,
        message: `TRUST_PROXY no admite rangos más amplios que /${String(MIN_TRUST_PROXY_IPV4_PREFIX)} en IPv4 ni /${String(MIN_TRUST_PROXY_IPV6_PREFIX)} en IPv6 (p. ej. 0.0.0.0/0, ::/0, ::ffff:0:0/96): confían en demasiados clientes y permiten falsificar X-Forwarded-For`,
      });
      return z.NEVER;
    }

    return entries.join(",");
  });

/**
 * `JWT_EXPIRES_IN` con formato `ms` y tope máximo (#52): mensajes distintos para formato inválido
 * y para vigencia excesiva, sin incluir valores de otras variables.
 */
const jwtExpiresInSchema = z
  .string({ error: "JWT_EXPIRES_IN debe ser una duración válida" })
  .trim()
  .refine(hasValidJwtExpiresInFormat, { error: JWT_EXPIRES_IN_FORMAT_MESSAGE, abort: true })
  .refine(isAllowedJwtExpiresIn, { error: JWT_EXPIRES_IN_MAX_MESSAGE })
  .default("1d");

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
  JWT_EXPIRES_IN: jwtExpiresInSchema,
  TRUST_PROXY: trustProxySchema,
});

/**
 * Describe la política efectiva de `trust proxy` para el log de arranque (sin datos sensibles).
 */
export function describeTrustProxy(setting: TrustProxySetting): string {
  if (setting === 0) {
    return "desactivado (se ignora X-Forwarded-For)";
  }
  if (typeof setting === "number") {
    return `${String(setting)} salto${setting === 1 ? "" : "s"} de proxy`;
  }
  return `direcciones de confianza ${setting}`;
}

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
