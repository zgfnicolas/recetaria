#!/usr/bin/env node
/**
 * Pruebas de humo del despliegue contenerizado (#24, Spec 06.3): `npm run docker:smoke`.
 *
 * Levanta cada stack en un proyecto Compose AISLADO y EFÍMERO, con un archivo de entorno propio
 * (secretos aleatorios de un solo uso): nunca lee el `.env` del usuario ni toca el proyecto
 * `recetaria` ni su base de desarrollo. Al terminar borra solo lo que creó (`down -v` del proyecto).
 *
 * - prod: compose.yaml + compose.smoke.yaml → imagen endurecida real, `healthy`, usuario `node`,
 *         raíz de solo lectura, NODE_ENV=production, 5 pruebas HTTP JSend y la prueba de ADR-0006
 *         (con PostgreSQL detenido, /health sigue 200 y el contenedor sigue `healthy`).
 * - dev:  compose.yaml + compose.override.yaml → contenedor de desarrollo, migrado y sembrado,
 *         con las mismas 5 pruebas HTTP. Requiere `npm run db:generate` en el host (./src montado).
 *
 * Opciones: --only=prod|dev · --keep (no desmonta, para depurar).
 * Puertos: SMOKE_PORT (3100), SMOKE_DEV_PORT (3101), SMOKE_DEV_DB_PORT (55432).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** Contraseña de desarrollo de los usuarios semilla (pública en el README; el seed solo corre en dev/test). */
const SEED_PASSWORD = "password123";
const HEALTH_TIMEOUT_MS = 240_000;
/** Tope por comando de Docker (un `up --build` colgado no bloquea el script para siempre). */
const COMMAND_TIMEOUT_MS = 15 * 60_000;
const args = new Set(process.argv.slice(2));
const only = [...args].find((a) => a.startsWith("--only="))?.slice("--only=".length);
const keep = args.has("--keep");

const SCENARIOS = [
  {
    name: "prod",
    project: "recetaria-smoke-prod",
    files: ["compose.yaml", "compose.smoke.yaml"],
    port: Number(process.env.SMOKE_PORT ?? 3100),
    env: (port) => ({ SMOKE_PORT: String(port) }),
    hardened: true,
  },
  {
    name: "dev",
    project: "recetaria-smoke-dev",
    files: ["compose.yaml", "compose.override.yaml"],
    port: Number(process.env.SMOKE_DEV_PORT ?? 3101),
    env: (port) => ({ PORT: String(port), POSTGRES_PORT: process.env.SMOKE_DEV_DB_PORT ?? "55432" }),
    hardened: false,
  },
].filter((s) => only === undefined || s.name === only);

/** Variables que el humo controla: se quitan del entorno heredado para que no las pise el shell. */
const CONTROLLED =
  /^(POSTGRES_|JWT_|DATABASE_URL|MIGRATION_DATABASE_URL|NODE_ENV|PORT|IMAGE_TAG|DEV_IMAGE_TAG|TRUST_PROXY|SMOKE_|COMPOSE_)/;
/** Imágenes que construye el humo (con etiquetas propias: nunca pisa recetaria/api:1.0.0 ni :dev). */
const SMOKE_IMAGES = ["recetaria/api:smoke", "recetaria/migrate:smoke", "recetaria/api:smoke-dev"];

const results = [];
function record(scenario, check, ok, detail = "") {
  results.push({ scenario, check, ok, detail });
  console.log(`${ok ? "✔" : "✘"} [${scenario}] ${check}${detail === "" ? "" : ` — ${detail}`}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeCompose(scenario, envFile) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !CONTROLLED.test(key)));
  return (...rest) => {
    const res = spawnSync(
      "docker",
      ["compose", "-p", scenario.project, "--env-file", envFile, ...scenario.files.flatMap((f) => ["-f", f]), ...rest],
      { cwd: ROOT, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: COMMAND_TIMEOUT_MS },
    );
    const timedOut = res.error !== undefined && "code" in res.error && res.error.code === "ETIMEDOUT";
    return {
      code: res.status ?? 1,
      out: `${timedOut ? "[timeout] " : ""}${res.stdout ?? ""}${res.stderr ?? ""}`.trim(),
    };
  };
}

function inspect(id, format) {
  const res = spawnSync("docker", ["inspect", "-f", format, id], { encoding: "utf8" });
  return (res.stdout ?? "").trim();
}

function writeEnvFile(scenario, dir) {
  const values = {
    POSTGRES_USER: "postgres",
    POSTGRES_DB: "recetaria",
    POSTGRES_PASSWORD: randomBytes(18).toString("hex"),
    JWT_SECRET: randomBytes(48).toString("base64url"),
    JWT_EXPIRES_IN: "1h",
    TRUST_PROXY: "0",
    IMAGE_TAG: "smoke",
    DEV_IMAGE_TAG: "smoke-dev",
    ...scenario.env(scenario.port),
  };
  const file = path.join(dir, `${scenario.name}.env`);
  writeFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n"), { mode: 0o600 });
  return file;
}

async function waitHealthy(compose, scenario) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const id = compose("ps", "-a", "-q", "api").out;
    if (id !== "") {
      const state = inspect(id, "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}");
      const restarts = Number(inspect(id, "{{.RestartCount}}") || "0");
      if (state.endsWith("healthy") && !state.endsWith("unhealthy") && restarts === 0) {
        return id;
      }
      // `restart: unless-stopped` convierte una caída en un bucle de reinicios: se corta enseguida
      if (/^(exited|dead|restarting)/.test(state) || state.endsWith("unhealthy") || restarts > 0) {
        throw new Error(`api en estado "${state}" (reinicios: ${String(restarts)})`);
      }
    }
    await sleep(2_000);
  }
  throw new Error(`api no llegó a healthy en ${String(HEALTH_TIMEOUT_MS / 1000)} s`);
}

async function http(scenario, method, route, { token, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${String(scenario.port)}${route}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const json = await res.json().catch(() => undefined);
  return { status: res.status, json };
}

/** Sobre JSend extendido: { success, statusCode (= status HTTP), message, data | errors }. */
function isJSend(res, expected) {
  const j = res.json;
  return (
    res.status === expected &&
    typeof j === "object" &&
    j !== null &&
    j.success === expected < 400 &&
    j.statusCode === expected &&
    typeof j.message === "string"
  );
}

async function smokeHttp(scenario) {
  const health = await http(scenario, "GET", "/health");
  record(scenario.name, "GET /health → 200 JSend", isJSend(health, 200));

  const ready = await http(scenario, "GET", "/health/ready");
  record(scenario.name, "GET /health/ready → 200 JSend", isJSend(ready, 200));

  const login = await http(scenario, "POST", "/api/v1/auth/login", {
    body: { email: "user@recetaria.com", password: SEED_PASSWORD },
  });
  const token = typeof login.json?.data?.token === "string" ? login.json.data.token : undefined;
  record(scenario.name, "POST /api/v1/auth/login (user semilla) → 200 JSend con token", isJSend(login, 200) && token !== undefined);

  const catalog = await http(scenario, "GET", "/api/v1/recipes");
  record(
    scenario.name,
    "GET /api/v1/recipes → 200 JSend { items, meta }",
    isJSend(catalog, 200) && Array.isArray(catalog.json?.data?.items) && typeof catalog.json?.data?.meta === "object",
  );

  const mine = await http(scenario, "GET", "/api/v1/recipes/mine", { token });
  record(scenario.name, "GET /api/v1/recipes/mine (Bearer) → 200 JSend", isJSend(mine, 200) && Array.isArray(mine.json?.data?.items));
}

function checkHardening(scenario, apiId, compose) {
  record(scenario.name, "api corre como usuario no-root `node`", inspect(apiId, "{{.Config.User}}") === "node");
  record(scenario.name, "api con sistema de archivos de solo lectura", inspect(apiId, "{{.HostConfig.ReadonlyRootfs}}") === "true");
  const env = inspect(apiId, "{{json .Config.Env}}");
  record(scenario.name, "api con NODE_ENV=production (no interpolado desde .env)", env.includes('"NODE_ENV=production"'));
  const image = inspect(apiId, "{{.Config.Image}}");
  const probe = (cmd) =>
    spawnSync("docker", ["run", "--rm", "--entrypoint", "sh", image, "-c", cmd], { encoding: "utf8", timeout: 60_000 }).stdout?.trim() ?? "";
  const osRelease = probe(". /etc/os-release && echo $ID-$VERSION_CODENAME");
  record(scenario.name, "imagen de producción sobre Debian Bookworm (slim)", osRelease === "debian-bookworm", osRelease);
  const nodeVersion = probe("node --version");
  record(scenario.name, "imagen de producción con Node 24 LTS", /^v24\./.test(nodeVersion), nodeVersion);
  const pgVersion = compose("exec", "-T", "postgres", "postgres", "--version").out;
  record(scenario.name, "PostgreSQL 15 en el stack", /\(PostgreSQL\) 15\./.test(pgVersion), pgVersion);
  const migrateId = compose("ps", "-a", "-q", "migrate").out;
  record(scenario.name, "migrate terminó con exit 0 antes de la API", inspect(migrateId, "{{.State.Status}} {{.State.ExitCode}}") === "exited 0");
}

/** ADR-0006: el HEALTHCHECK usa /health (liveness) y NO depende de la base. */
async function checkHealthcheckWithoutDatabase(scenario, apiId, compose) {
  const stoppedAt = Date.now();
  compose("stop", "postgres");
  const health = await http(scenario, "GET", "/health");
  record(scenario.name, "ADR-0006: con PostgreSQL detenido, /health sigue 200", isJSend(health, 200));
  const ready = await http(scenario, "GET", "/health/ready");
  record(scenario.name, "ADR-0006: con PostgreSQL detenido, /health/ready → 503 JSend", isJSend(ready, 503));

  // Espera una sonda del HEALTHCHECK posterior al corte (intervalo de 30 s en el Dockerfile)
  // Docker tolera `retries` fallos antes de marcar unhealthy: se exige una sonda EXITOSA post-corte.
  const deadline = Date.now() + 75_000;
  let probes = [];
  while (Date.now() < deadline && !probes.some((entry) => entry.ExitCode === 0)) {
    const raw = inspect(apiId, "{{json .State.Health}}");
    const healthState = raw === "" ? undefined : JSON.parse(raw);
    probes = (healthState?.Log ?? []).filter((entry) => Date.parse(entry.Start) > stoppedAt);
    if (!probes.some((entry) => entry.ExitCode === 0)) {
      await sleep(3_000);
    }
  }
  const ok = probes.length > 0 && probes.every((entry) => entry.ExitCode === 0);
  const status = inspect(apiId, "{{.State.Health.Status}}");
  record(
    scenario.name,
    "ADR-0006: el HEALTHCHECK siguió en healthy sin base",
    ok && status === "healthy",
    `${String(probes.filter((entry) => entry.ExitCode === 0).length)}/${String(probes.length)} sondas OK tras el corte · ${status}`,
  );
}

/** Proyectos levantados en esta corrida: se desmontan también ante Ctrl+C / SIGTERM. */
const active = new Map();

async function runScenario(scenario, dir) {
  const compose = makeCompose(scenario, writeEnvFile(scenario, dir));
  console.log(`\n▶ ${scenario.name}: proyecto ${scenario.project} (${scenario.files.join(" + ")})`);
  // Restos de una corrida anterior con --keep: se parte siempre de un proyecto limpio
  compose("down", "-v", "--remove-orphans");
  active.set(scenario.project, compose);
  try {
    const up = compose("up", "-d", "--build");
    record(scenario.name, "docker compose up --build", up.code === 0, up.code === 0 ? "" : up.out.split("\n").slice(-5).join(" | "));
    if (up.code !== 0) {
      return;
    }
    const apiId = await waitHealthy(compose, scenario);
    record(scenario.name, "api alcanza estado healthy (HEALTHCHECK sobre /health)", true);
    if (scenario.hardened) {
      checkHardening(scenario, apiId, compose);
    }
    await smokeHttp(scenario);
    if (scenario.hardened) {
      await checkHealthcheckWithoutDatabase(scenario, apiId, compose);
    }
  } catch (err) {
    record(scenario.name, "ejecución del escenario", false, err instanceof Error ? err.message : String(err));
    console.log(compose("logs", "--no-color", "--tail", "40", "api", "migrate").out);
  } finally {
    if (keep) {
      console.log(`(--keep) proyecto ${scenario.project} sin desmontar`);
    } else {
      const down = compose("down", "-v", "--remove-orphans");
      record(scenario.name, "limpieza del proyecto efímero (down -v)", down.code === 0);
    }
    active.delete(scenario.project);
  }
}

const dir = mkdtempSync(path.join(tmpdir(), "recetaria-smoke-"));

function abort(signal) {
  console.log(`\n${signal}: desmontando ${String(active.size)} proyecto(s) del humo…`);
  if (!keep) {
    for (const compose of active.values()) {
      compose("down", "-v", "--remove-orphans");
    }
  }
  rmSync(dir, { recursive: true, force: true });
  process.exit(130);
}
process.once("SIGINT", () => abort("SIGINT"));
process.once("SIGTERM", () => abort("SIGTERM"));
try {
  if (SCENARIOS.length === 0) {
    throw new Error(`--only debe ser prod o dev (recibido: ${String(only)})`);
  }
  for (const scenario of SCENARIOS) {
    await runScenario(scenario, dir);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
  if (!keep) {
    // Solo las etiquetas propias del humo (la caché de BuildKit se conserva para la próxima corrida)
    spawnSync("docker", ["image", "rm", ...SMOKE_IMAGES], { encoding: "utf8" });
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "✅" : "❌"} ${String(results.length - failed.length)}/${String(results.length)} verificaciones OK`);
process.exit(failed.length === 0 && results.length > 0 ? 0 : 1);
