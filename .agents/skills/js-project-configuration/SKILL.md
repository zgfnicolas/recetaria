---
name: js-project-configuration
description: >-
  Configura y audita proyectos Node.js/TypeScript reproducibles con supply chain
  endurecida para Recetaria API — runtime Node LTS (.node-version, engines/devEngines),
  npm 12 por defecto (allowScripts, min-release-age, .npmrc, npm ci, lockfile-lint,
  audit signatures) y pnpm 11 como alternativa (pnpm-workspace.yaml, allowBuilds,
  minimumReleaseAge), validación de entorno con Zod 4, CI en GitHub Actions,
  Renovate/Dependabot con cooldown y apagado ordenado del servidor. Usar al configurar
  package.json, dependencias, .npmrc, CI, variables de entorno o hardening de build.
---

# Configuración de Proyecto Node.js / TypeScript — Recetaria API

**Principio rector:** un clon limpio + una instalación congelada producen exactamente el mismo árbol de dependencias, el mismo build y el mismo artefacto en local, en CI y en producción.

**Prioridades:** Reproducibilidad → Seguridad de la supply chain → Correctitud → Simplicidad → Velocidad.

## 1. Reglas duras (MUST)

- **Runtime LTS fijado:** usar Node Active o Maintenance LTS, declarado en `.node-version` y validado en `engines` y `devEngines` de `package.json`.
- **Un solo gestor y lockfile congelado:** usar **`npm` por defecto** (`package-lock.json` + `npm ci`) o **`pnpm` como alternativa** (`pnpm-lock.yaml` + `pnpm install --frozen-lockfile`). Nunca versionar dos lockfiles ni editarlos a mano.
- **Install scripts por allowlist estricta:** mantener `allowScripts` en `package.json` (`npm`) o `allowBuilds` en `pnpm-workspace.yaml` (`pnpm`) con modo estricto activo; revisar cualquier diff de la allowlist con el mismo rigor que el lockfile.
- **Cooldown de paquetes nuevos:** configurar espera mínima de **3 días** (`min-release-age=3` en `.npmrc` o `minimumReleaseAge: 4320` en `pnpm-workspace.yaml`), alineado con Renovate/Dependabot; excepciones solo para parches de seguridad urgentes documentados en el PR.
- **Fuentes Git/URL bloqueadas:** mantener bloqueadas las dependencias desde Git, URLs o tarballs remotos (`allow-git=none`, `allow-remote=none` en npm 12; `blockExoticSubdeps: true` en pnpm 11).
- **Verificación de integridad en CI:** correr `lockfile-lint`, `npm audit signatures` y auditoría de producción (`npm audit --omit=dev --audit-level=high` / `pnpm audit --prod`). Nunca ejecutar `audit fix --force` automático.
- **Entorno validado al arrancar:** validar `process.env` con **Zod 4** en `src/config/env.ts` (`z.url(...)`, nunca `z.string().url()`). Nunca versionar `.env`, incrustarlo en imágenes Docker ni loguear `process.env`.
- **Producción endurecida y apagado ordenado:** artefacto sin `devDependencies`, usuario `node` (no root) y *graceful shutdown* con timeout menor a `stop_grace_period: 15s` de `compose.yaml`.

## 2. Runtime Node LTS (Baseline nov. 2026)

| Línea | Estado (nov. 2026) | Uso recomendado |
|---|---|---|
| **26.x** *(Active LTS)* | Soportada hasta abril 2029 | Default para proyectos nuevos y destino de migración |
| **24.x** *(Maintenance LTS)* | Soportada hasta abril 2028 | Proyectos existentes con dependencias bloqueadas en 26 |
| **22.x** *(Maintenance LTS)* | Soportada hasta abril 2027 | Baseline actual del `Dockerfile` de Recetaria; planificar salto a 24/26 |
| **≤ 20.x** | EOL | Prohibido en producción |

- Nunca acotes el gestor con techo superior de major (ej. `"npm": "<12"`), porque rompe instalaciones al actualizar npm.
- En Node ≥ 25 Corepack ya no viene incluido: si optás por `pnpm`, instalalo con `pnpm/action-setup` en CI y el instalador oficial/`mise` en local.

## 3. Gestor de paquetes: `npm 12` (por defecto) vs. `pnpm 11` (alternativa)

| Aspecto | `npm 12` *(Por defecto en Recetaria)* | `pnpm 11` *(Alternativa)* |
|---|---|---|
| **Instalación en CI/Docker** | `npm ci` | `pnpm install --frozen-lockfile` |
| **Configuración** | `.npmrc` (sin tokens) + `package.json` | `pnpm-workspace.yaml` (`.npmrc` solo auth/registry) |
| **Allowlist de scripts** | `allowScripts` en `package.json` (`strict-allow-scripts=true`) | `allowBuilds` en `pnpm-workspace.yaml` (`strictDepBuilds: true`) |
| **Aprobar/denegar scripts** | `npm approve-scripts <pkg>` / `npm deny-scripts <pkg>` | `pnpm approve-builds` |
| **Cooldown** | `min-release-age=3` (días) | `minimumReleaseAge: 4320` (minutos) |
| **Fuentes exóticas** | `allow-git=none`, `allow-remote=none` (default) | `blockExoticSubdeps: true` (default) |

- Recetaria ya declara `"allowScripts"` en `package.json` (`bcrypt@6.0.0`, `esbuild@0.28.2`). Aprobá versiones concretas tras inspeccionar qué ejecutan; evitá `--ignore-scripts` global porque rompe binarios nativos legítimos (`bcrypt`, Prisma engines).

## 4. Dependencias, Overrides y Entorno

- **Taxonomía:** todo lo importado en runtime (`express`, `zod`, `bcrypt`, `jsonwebtoken`, `cors`, `dotenv`, `@prisma/client`) va en `dependencies`. Build, tipos, linters, Prisma CLI y tests (`typescript`, `ts-node-dev`, `prisma`, `@types/*`, `vitest`, `supertest`, `lockfile-lint`) van en `devDependencies`.
- **Antes de agregar un paquete:** verificá si Node nativo ya lo resuelve (`fetch`, `crypto.randomUUID`, `structuredClone`, `node:test`), revisá transitivas (`npm i <pkg> --dry-run`) e inspeccioná si trae install scripts.
- **Overrides:** solo para parchear una transitiva vulnerable o unificar versiones. En `npm`, registrá cada clave de `overrides` en `docs/dependency-overrides.md` (`paquete | versión | CVE/motivo | fecha | dueño | condición de salida`); en `pnpm`, comentala en `pnpm-workspace.yaml`. Revisión mensual.
- **Variables de entorno:** la consigna del TP requiere cargar `.env` con `dotenv` en desarrollo (en proyectos fuera del TP, `node --env-file-if-exists=.env` lo reemplaza); en producción se inyectan desde el orquestador/Compose. Todo script de `package.json` invoca binarios locales directo (`tsc`, `vitest`, `lockfile-lint`), nunca `npx`.

## 5. Plantillas y Configuraciones (Referencia bajo demanda)

Consultá [`references/configs-and-ci.md`](./references/configs-and-ci.md) cuando necesites:
- `.node-version`, `.npmrc`, `package.json` (`engines`, `devEngines`, `allowScripts`, scripts de seguridad) para **npm 12**.
- `pnpm-workspace.yaml` y pasos de cambio limpio si elegís **pnpm 11**.
- `src/config/env.ts` (esquema Zod 4 adaptado a `.env.example` de Recetaria + test unitario).
- `src/server.ts` (*graceful shutdown* con `closeIdleConnections()`, `prisma.$disconnect()` y `SHUTDOWN_TIMEOUT_MS = 10_000`).
- `.github/workflows/ci.yml` (npm por defecto + variante pnpm), `renovate.json` y `.github/dependabot.yml`.

*(Para estructura modular en 4 capas usá [layered-architecture-ts](../layered-architecture-ts/SKILL.md); para Dockerfile multi-stage y Compose endurecido usá [docker-production-containers](../docker-production-containers/SKILL.md) y [docker-deploy](../docker-deploy/SKILL.md); para hooks Git, Conventional Commits y `.gitattributes` usá [git-workflow-engineering](../git-workflow-engineering/SKILL.md); para rulesets, Dependabot y políticas de Actions en GitHub usá [github-repository-governance](../github-repository-governance/SKILL.md).)*

## 6. Antipatrones a evitar

- Lockfile sin versionar, editado a mano o coexistencia de `package-lock.json` y `pnpm-lock.yaml`.
- `npm install` sin `ci` / `--frozen-lockfile` en CI o Docker.
- `@prisma/client` o `zod` en `devDependencies`, o `devDependencies` presentes en la imagen final de runtime.
- Aprobar scripts con `--all` sin revisar, usar `--ignore-scripts` global o correr `npm audit fix --force`.
- Cooldown del bot (Renovate/Dependabot) menor que el del gestor, o `overrides` sin motivo ni fecha de retiro.
- `z.string().url()` en Zod 4 (usar `z.url()`), loguear `process.env` o incrustar `.env` en capas Docker.
- `server.close()` sin promesa ni cierre de conexiones ociosas, o seguir vivo tras `uncaughtException`/`unhandledRejection`.
- Tokens npm en `.npmrc` versionado o `npx` dentro de scripts de `package.json`.

## 7. Definition of Done

Una configuración de proyecto se considera completa solo cuando cumple todo:
- [ ] `.node-version` en una LTS soportada, `engines`/`devEngines` coherentes y un único lockfile versionado.
- [ ] `.npmrc` (o `pnpm-workspace.yaml`) con allowlist estricta de scripts, cooldown ≥ 3 días y bloqueo de fuentes Git/URL.
- [ ] `src/config/env.ts` valida todas las variables de `.env.example` con Zod 4 y tiene test unitario de fallo.
- [ ] CI en `.github/workflows/ci.yml` corre desde clon limpio: instalación congelada → `lint:lockfile` → `audit signatures` → `typecheck` → `test` → `build` → `audit` de producción.
- [ ] `src/server.ts` implementa apagado ordenado con timeout (< `15s`) y cierra Express y Prisma ante `SIGTERM`/`SIGINT`/errores fatales.
