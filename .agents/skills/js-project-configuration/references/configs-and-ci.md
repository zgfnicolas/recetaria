# Plantillas de Configuración, Entorno, Ciclo de Vida y CI — Recetaria API

Configuraciones listas para adaptar en Recetaria API usando **`npm` 12 por defecto** y **`pnpm` 11 como alternativa**.

---

## 1. Configuración por defecto (`npm 12`)

### `.node-version`
```text
22.14.0
```
*(Al migrar el `Dockerfile` a Node 26 LTS o 24 LTS, actualizá `.node-version`, `Dockerfile` y `engines`/`devEngines` en el mismo PR).*

### `.npmrc` (versionado, sin tokens)
```ini
save-exact=true
engine-strict=true
strict-peer-deps=true
strict-allow-scripts=true
min-release-age=3
fund=false
# allow-git=none y allow-remote=none vienen activos por defecto en npm 12
```

### Extracto de `package.json` (`engines`, `devEngines`, `allowScripts` y scripts)
```json
{
  "private": true,
  "engines": {
    "node": ">=22.14.0"
  },
  "devEngines": {
    "runtime": { "name": "node", "version": ">=22.14.0", "onFail": "error" },
    "packageManager": { "name": "npm", "version": ">=12.0.0", "onFail": "error" }
  },
  "scripts": {
    "dev": "ts-node-dev --respawn --transpile-only src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint:lockfile": "lockfile-lint --path package-lock.json --type npm --allowed-hosts npm --validate-https --validate-integrity",
    "audit:deps": "npm audit --omit=dev --audit-level=high",
    "audit:signatures": "npm audit signatures",
    "check": "npm run typecheck && npm test && npm run build"
  },
  "allowScripts": {
    "bcrypt@6.0.0": true,
    "esbuild@0.28.2": true
  }
}
```

### Flujo de scripts en `npm 12`
```bash
npm install                                   # resuelve y avisa qué install scripts faltan aprobar
npm approve-scripts --allow-scripts-pending   # inspección en solo lectura
npm approve-scripts bcrypt esbuild            # aprueba tras revisar qué ejecutan
npm deny-scripts core-js                      # registra denegación explícita
npm install zod@4.6.7 --min-release-age=0     # excepción puntual solo para fix de seguridad (documentar en PR)
```

---

## 2. Alternativa con `pnpm 11`

Si decidís cambiar el repositorio a **pnpm 11**:
1. Eliminá `package-lock.json` y `.npmrc` con settings de npm (en pnpm 11 `.npmrc` solo guarda auth/registry).
2. Declaré `"packageManager": "pnpm@11.x.y"` y `devEngines.packageManager.name = "pnpm"` en `package.json`.
3. Creá `pnpm-workspace.yaml` en la raíz:

```yaml
# pnpm-workspace.yaml (single-repo con pnpm 11)
savePrefix: ""
engineStrict: true
strictPeerDependencies: true

# Supply chain
minimumReleaseAge: 4320       # 3 días en minutos
blockExoticSubdeps: true      # transitivas solo desde registries
strictDepBuilds: true         # build script no aprobado = error
allowBuilds:
  bcrypt: true
  esbuild: true
  "@prisma/engines": true

# Overrides siempre documentados con motivo y fecha
# overrides:
#   "paquete-vulnerable": 1.2.3  # CVE-2026-XXXX; quitar cuando dep padre actualice (YYYY-MM-DD, @owner)
```

Comandos clave:
```bash
pnpm approve-builds               # revisión interactiva que actualiza allowBuilds
pnpm install --frozen-lockfile    # instalación congelada en CI y Docker
pnpm audit --prod --audit-level high
```

---

## 3. Validación de entorno al arrancar (`src/config/env.ts` con Zod 4)

Alineado con [`.env.example`](../../../../.env.example) y el Requisito 10 del TP (`dotenv`):

```typescript
// src/config/env.ts
import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  JWT_SECRET: z.string().min(32, "JWT_SECRET debe tener al menos 32 caracteres"),
  JWT_EXPIRES_IN: z.string().min(1).default("1d"),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    // Reporta nombres de variables y motivo, nunca valores
    const problems = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Configuración inválida: ${problems}`);
  }
  return result.data;
}

export function loadEnv(): Env {
  return parseEnv(process.env);
}
```

Test unitario mínimo (`src/config/env.test.ts`):
```typescript
it("rechaza DATABASE_URL con protocolo distinto de PostgreSQL", () => {
  expect(() =>
    parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: "mysql://user:pass@localhost:3306/db",
      JWT_SECRET: "a".repeat(32),
    }),
  ).toThrow(/DATABASE_URL/);
});
```

---

## 4. Ciclo de vida del proceso (`src/server.ts`)

Timeout de apagado (`10s`) menor que `stop_grace_period: 15s` definido en `compose.yaml`:

```typescript
// src/server.ts (extracto de graceful shutdown)
const SHUTDOWN_TIMEOUT_MS = 10_000;
let shuttingDown = false;

function closeServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeIdleConnections();
  });
}

async function shutdown(reason: string, error?: unknown): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  if (error) console.error(`[SHUTDOWN:${reason}]`, error);
  else console.log(`[SHUTDOWN:${reason}] Cerrando conexiones...`);

  const force = setTimeout(() => {
    console.error(`[SHUTDOWN:${reason}] Timeout superado, salida forzada`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();

  try {
    await closeServer();
    await container.dispose(); // prisma.$disconnect()
  } catch (err) {
    console.error("[SHUTDOWN_ERROR]", err);
    error ??= err;
  } finally {
    clearTimeout(force);
    process.exit(error ? 1 : 0);
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (err) => void shutdown("uncaughtException", err));
process.on("unhandledRejection", (err) => void shutdown("unhandledRejection", err));
```

---

## 5. CI en GitHub Actions (`.github/workflows/ci.yml`)

Reemplazá `<sha>` por el commit SHA fijado de cada Action al activarlo:

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@<sha>
        with:
          persist-credentials: false
      - uses: actions/setup-node@<sha>
        with:
          node-version-file: .node-version
          cache: npm
      - run: npm ci
      - run: npm run lint:lockfile
      - run: npm audit signatures
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - run: npm audit --omit=dev --audit-level=high
```

### Variante `pnpm 11` (pasos a reemplazar en `verify`)
```yaml
      - uses: pnpm/action-setup@<sha>      # lee la versión de "packageManager"
      - uses: actions/setup-node@<sha>
        with:
          node-version-file: .node-version
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run typecheck
      - run: pnpm test
      - run: pnpm run build
      - run: pnpm audit --prod --audit-level high
```

---

## 6. Actualización de dependencias con Cooldown

### `renovate.json` (Opción 1)
```json
{
  "extends": ["config:recommended", ":pinAllExceptPeerDependencies"],
  "minimumReleaseAge": "3 days",
  "internalChecksFilter": "strict",
  "lockFileMaintenance": { "enabled": true, "schedule": ["before 6am on monday"] },
  "packageRules": [
    { "matchUpdateTypes": ["patch", "minor"], "matchCurrentVersion": "!/^0/", "groupName": "non-major", "automerge": true },
    { "matchUpdateTypes": ["major"], "automerge": false, "labels": ["major-upgrade"] },
    { "matchDepTypes": ["devDependencies"], "matchUpdateTypes": ["patch", "minor"], "groupName": "dev tooling" }
  ],
  "vulnerabilityAlerts": { "minimumReleaseAge": null }
}
```

### `.github/dependabot.yml` (Opción 2)
```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    cooldown:
      default-days: 3
      semver-major-days: 14
    groups:
      non-major:
        update-types: [minor, patch]
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```
