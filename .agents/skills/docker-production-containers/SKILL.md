---
name: docker-production-containers
description: >-
  Diseña, construye, endurece, publica y opera contenedores Docker de producción para
  Recetaria API (Node.js 22+ LTS + Prisma + PostgreSQL 15+ + Compose v2) — Dockerfile
  multi-stage, BuildKit cache/secrets, .dockerignore allowlist, usuario no-root y código
  inmutable, Compose endurecido (read_only, cap_drop, redes internal, DOCKER-USER, *_FILE),
  persistencia y volúmenes PostgreSQL (PG 15 vs PG 18), healthchecks y SIGTERM, límites de
  memoria (--max-old-space-size), logs, escaneo CVE/Trivy, SBOM/provenance/Cosign y
  verificación. Usar al diseñar o auditar Dockerfile, compose.yaml o pipelines de imágenes.
---

# Contenedores Docker de Producción (Recetaria API)

Baseline: Docker Engine + BuildKit/Buildx + **Compose v2** ([Dockerfile](../../../Dockerfile), [compose.yaml](../../../compose.yaml), [compose.override.yaml](../../../compose.override.yaml), [.dockerignore](../../../.dockerignore)), runtime **`node:22.14.0-bookworm-slim`** (`glibc` requerido por Prisma y `bcrypt`) y **`postgres:15.12-alpine`**.
Prioridades: **Seguridad → Reproducibilidad/Trazabilidad → Correctitud operativa (señales, salud, estado) → Observabilidad → Tamaño/velocidad de build**.

> [!NOTE]
> Respetar los límites de [AGENTS.md](../../../AGENTS.md): no modificar `Dockerfile`, `compose.yaml`, `.env` ni `secrets/` sin confirmación explícita del usuario.

## 0. Modo de trabajo y reglas duras (MUST)

Antes de diseñar o auditar, relevar: runtime y dependencias nativas (`glibc`, OpenSSL/Prisma), proceso principal y drenaje ante `SIGTERM`, `/health` (liveness vs readiness), separación config vs secretos, escrituras en disco y destino (Compose en un host vs orquestador futuro).

**Formato de entrega:** `Dockerfile` + `.dockerignore` + `compose.yaml` (y overrides) ejecutables + tabla de decisiones (*base, usuario, FS, capabilities, puertos, persistencia, secretos*) + pasos de verificación.

**Reglas duras:**
1. Construir la imagen **una vez en CI** y promoverla por digest (`@sha256:...`); nunca `build` en producción ni imágenes distintas por entorno.
2. Imagen base fijada por digest con PRs automáticos (Renovate/Dependabot) + lockfile (`package-lock.json` + `npm ci`).
3. Proceso como usuario no-root (`USER node`, `uid=1000`); código de la app propiedad de `root` (no escribible por la app).
4. Cero secretos en la imagen (`ENV`, `ARG`, capas, `docker history`) ni en Git; en build usar `--mount=type=secret`; en runtime preferir archivos `/run/secrets/*` y convención `*_FILE`.
5. Prohibido `privileged: true`, montar `/var/run/docker.sock` o `network_mode: host` sin excepción documentada.
6. En producción solo el proxy inverso publica puertos hacia el exterior; servicios internos sin `ports:` (en dev solo `127.0.0.1:...`).
7. Estado de negocio fuera de la capa escribible (volúmenes nombrados o DB gestionada).
8. PID 1 correcto (`CMD ["node", "dist/index.js"]` en forma exec + `init: true`) y graceful shutdown dentro de `stop_grace_period`.
9. Logs JSON a `stdout`/`stderr` con driver `local` y rotación configurada en el host.
10. Escaneo bloqueante en CI (`Trivy`/secretos/`hadolint`), SBOM/provenance/firma (`Cosign`) y escaneo continuo de lo publicado.

## 1. Dockerfile, imagen base y secretos

- **`.dockerignore`:** preferir **allowlist** (`*` y re-incluir solo `package.json`, `package-lock.json`, `tsconfig.json`, `prisma.config.ts`, `prisma/`, `src/`). Nunca pasar `.git`, `.env`, `secrets/`, `node_modules` o `dist` al contexto.
- **Multi-stage Node/Prisma:** `base` (`bookworm-slim` con `openssl` + `ca-certificates` en una sola capa `apt-get` limpia) → `deps` (`--mount=type=cache,target=/root/.npm` + `npm ci`) → `build` (`tsc` + `prisma generate` + `npm prune --omit=dev`) → `test` (`docker build --target test` en CI) → `production` (`ENV NODE_ENV=production` **solo** en runtime, código propiedad de `root`, `USER node`, `HEALTHCHECK` en forma exec con `node`, sin `curl`).
- **Imagen base:** `bookworm-slim` es la elección correcta para Recetaria por compatibilidad `glibc` con `bcrypt` y Prisma (evitar `alpine` en la API por `musl`).
- **Secretos:** nunca `ARG`/`ENV` en build; en Compose productivo usar `secrets:` + `*_FILE` aprovisionados desde un gestor externo (Vault/KMS/SOPS), nunca commiteados.

## 2. Runtime endurecido, redes, persistencia y ciclo de vida

- **Hardening en `compose.yaml`:** `init: true`, `read_only: true`, `tmpfs: ["/tmp:size=64m,mode=1777"]`, `cap_drop: [ALL]`, `security_opt: ["no-new-privileges:true"]`, `mem_limit: 512m`, `cpus: 1.0`, `pids_limit: 200`, `stop_grace_period: 30s` (alineado al drenaje real).
- **Memoria Node:** acompañar `mem_limit: 512m` con `NODE_OPTIONS=--max-old-space-size=384` (~75 % del límite) para evitar `OOMKilled` silencioso.
- **Redes y firewall:** `application` (API/proxy) + `data` (`internal: true` para `postgres`). Docker saltea UFW/firewalld al publicar `ports:`: filtrar tráfico externo en `DOCKER-USER` y jamás publicar `5432` fuera de `127.0.0.1`.
- **PostgreSQL en contenedor:**
  - En **PG 15–17** (Recetaria actual): volumen en `/var/lib/postgresql/data`.
  - En **PG 18+**: el layout oficial cambió a `/var/lib/postgresql`. Verificar antes de cualquier upgrade mayor.
  - Definir `shm_size: 256m`, `stop_grace_period: 60s` y `healthcheck` con `pg_isready`. Un volumen local no es un backup ni evita punto único de falla.
- **Salud y señales:** liveness (`/health`) liviano **sin** consultar PostgreSQL (evita reinicios en cascada); readiness aparte si verifica DB. Docker standalone no reinicia contenedores `unhealthy`; `depends_on: service_healthy` ordena arranque pero no sustituye reconexión/backoff en la app.

## 3. Brechas actuales del repo hacia producción madura

Al auditar los archivos actuales de Recetaria ([Dockerfile](../../../Dockerfile) y [compose.yaml](../../../compose.yaml)), priorizar estas mejoras cuando el usuario apruebe tocar Docker:
1. Fijar bases `node:22.14.0-bookworm-slim` y `postgres:15.12-alpine` por `@sha256:<digest>` + agregar `LABEL org.opencontainers.image.*`.
2. Quitar `--chown=node:node` en el stage `production` para que el código sea solo lectura para `USER node`, y usar forma exec en `HEALTHCHECK`.
3. Migrar `POSTGRES_PASSWORD` / `JWT_SECRET` de `environment:` a `secrets:` + `*_FILE`, y separar `app_runtime` de `postgres` superuser.
4. Añadir `NODE_OPTIONS=--max-old-space-size=384` en `api` y `shm_size: 256m` en `postgres`.

## 4. Colaboración y delegación

| Necesidad | Skill |
|---|---|
| Comandos diarios locales (`npm run docker:*`) y checklist rápido | [docker-deploy](../docker-deploy/SKILL.md) |
| Internals, roles, backups/PITR y upgrades de PostgreSQL | [postgresql-engineering](../postgresql-engineering/SKILL.md) |
| Presupuesto de pool Prisma, conexión directa y job `prisma migrate deploy` | [orm-persistence-js-ts](../orm-persistence-js-ts/SKILL.md) |
| Señales `SIGTERM`, graceful shutdown y límites de memoria Node.js | [node-backend-engineering](../node-backend-engineering/SKILL.md) |
| Node LTS, `npm ci`, lockfiles, CI GitHub Actions y Renovate | [js-project-configuration](../js-project-configuration/SKILL.md) |
| Gobernanza GitHub (deploy por digest, environments, attestations) y operación `gh` | [github-repository-governance](../github-repository-governance/SKILL.md) · [github-cli-agentic](../github-cli-agentic/SKILL.md) |
| Contrato `/health` (liveness vs readiness) y timeouts HTTP | [api-engineering-ts](../api-engineering-ts/SKILL.md) |

Para `.dockerignore` allowlist, `Dockerfile` y `compose.yaml` productivos de referencia, `daemon.json`, pipeline Buildx/Trivy/Cosign, batería de verificación (§14) y **Definition of Done**, consultá [references/docker-patterns.md](./references/docker-patterns.md).
