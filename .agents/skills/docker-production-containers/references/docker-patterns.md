# Patrones Docker de Producción para Recetaria API

Referencia ejecutable de [docker-production-containers](../SKILL.md) adaptada al stack **Node.js 22+ LTS + TypeScript + Prisma + PostgreSQL 15+ + Compose v2** de Recetaria API. Para comandos cotidianos de desarrollo ver [docker-deploy](../../docker-deploy/SKILL.md); para operación y PITR de PostgreSQL ver [postgresql-engineering](../../postgresql-engineering/SKILL.md).

---

## 1. `.dockerignore` en formato allowlist

```dockerignore
*
!package.json
!package-lock.json
!tsconfig.json
!prisma.config.ts
!prisma/
!src/
# Excluye por defecto .git, .env*, secrets/, node_modules, dist, coverage, logs y docs
```

Verificar el tamaño real enviado al daemon en la línea `transferring context` de `docker build`.

---

## 2. `Dockerfile` endurecido de referencia (Node.js + Prisma)

```dockerfile
# syntax=docker/dockerfile:1
ARG NODE_VERSION=24-bookworm-slim
# En Fase Beta fijar por digest real (@sha256:<digest>); actualizar vía Dependabot
FROM node:${NODE_VERSION} AS base

# OpenSSL y certificados para el query engine de Prisma en una sola capa limpia
RUN apt-get update -y \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- dependencias de producción ----
FROM base AS deps
COPY package.json package-lock.json prisma.config.ts ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# ---- build (con devDependencies + Prisma client) ----
FROM base AS build
COPY package.json package-lock.json prisma.config.ts ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
RUN npx prisma generate && npm run build

# ---- target de tests para CI (docker build --target test) ----
FROM build AS test
RUN npm test

# ---- runtime de producción (inmutable, no-root) ----
FROM base AS production
ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS="--max-old-space-size=384"

# Propiedad de root (sin --chown=node:node): el proceso node no puede reescribir su propio código
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

ARG GIT_SHA=unknown
LABEL org.opencontainers.image.revision=$GIT_SHA \
      org.opencontainers.image.source="https://github.com/facundovega/recetaria-api"

USER node
EXPOSE 3000

# Healthcheck en forma exec sin curl (liveness liviano; no consultar DB)
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "dist/server.js"]
```

- **Secretos de build (si hay registry privado):** `RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci` con `docker buildx build --secret id=npmrc,src=$HOME/.npmrc .`. Jamás `ARG TOKEN` ni `ENV TOKEN`.

---

## 3. Compose por entorno (objetivo productivo + override local)

### 3.1 Base productiva (`compose.yaml` endurecido)
```yaml
name: recetaria

services:
  api:
    image: ${API_IMAGE:?definir API_IMAGE=ghcr.io/org/recetaria-api@sha256:...}
    init: true
    restart: unless-stopped
    environment:
      NODE_ENV: production
      PORT: "3000"
      DATABASE_HOST: postgres
      DATABASE_NAME: recetaria
      DATABASE_USER: recetaria_runtime
      DATABASE_PASSWORD_FILE: /run/secrets/db_password
      JWT_SECRET_FILE: /run/secrets/jwt_secret
      JWT_EXPIRES_IN: ${JWT_EXPIRES_IN:-1d}
    secrets: [db_password, jwt_secret]
    networks: [application, data]
    depends_on:
      postgres:
        condition: service_healthy
    read_only: true
    tmpfs: ["/tmp:size=64m,mode=1777"]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    cpus: 1.0
    mem_limit: 512m
    pids_limit: 200
    stop_grace_period: 30s

  postgres:
    image: postgres:15.12-alpine@sha256:<digest>
    init: true
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-postgres}
      POSTGRES_DB: ${POSTGRES_DB:-recetaria}
      POSTGRES_PASSWORD_FILE: /run/secrets/db_password
    secrets: [db_password]
    volumes:
      # PG 15–17 usa /var/lib/postgresql/data; si se actualiza a PG 18+, cambiar a /var/lib/postgresql
      - postgres_data:/var/lib/postgresql/data
    networks: [data]
    shm_size: 256m
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER:-postgres} -d $${POSTGRES_DB:-recetaria}"]
      interval: 10s
      timeout: 3s
      retries: 5
      start_period: 30s
    cpus: 1.0
    mem_limit: 512m
    pids_limit: 200
    stop_grace_period: 60s

  proxy:
    image: caddy:2@sha256:<digest>
    restart: unless-stopped
    ports: ["80:80", "443:443"]   # único servicio publicado hacia Internet
    volumes:
      - ./deploy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    networks: [application]
    cap_drop: [ALL]
    cap_add: [NET_BIND_SERVICE]

networks:
  application: {}
  data:
    internal: true

volumes:
  postgres_data: {}
  caddy_data: {}

secrets:
  db_password:
    file: ${DB_PASSWORD_FILE:-./secrets/db_password}
  jwt_secret:
    file: ${JWT_SECRET_FILE:-./secrets/jwt_secret}
```

### 3.2 Desarrollo (`compose.override.yaml`)
- Publicar solo en loopback (`127.0.0.1:3000:3000`, `127.0.0.1:5432:5432`), usar `develop.watch` (o bind mounts `:ro`) para hot reload y aislar herramientas auxiliares como Adminer bajo `profiles: [debug]`.
- En producción ejecutar siempre con `-f` explícito (`docker compose -f compose.yaml -f compose.production.yaml pull && up -d --wait`) para evitar cargar `compose.override.yaml` por accidente.

---

## 4. Baseline del host (`/etc/docker/daemon.json`) y observabilidad

```json
{
  "log-driver": "local",
  "log-opts": { "max-size": "10m", "max-file": "5" },
  "live-restore": true,
  "no-new-privileges": true
}
```

- Programar limpieza periódica de disco (`docker image prune` / `docker builder prune` con filtro `until=168h`) y vigilar `docker system df` (en Docker Engine 29+ con containerd image store, incluir `/var/lib/containerd`).
- Diagnosticar primero sin entrar al contenedor: `docker compose ps`, `logs`, `inspect`, `stats`, `events`, y verificar OOM con `docker inspect -f '{{.State.OOMKilled}}' <ctr>`.

---

## 5. CI/CD, cadena de suministro y política de CVEs

Flujo: `lint (TS + hadolint + compose config)` → `tests` → `docker build --target test` → `buildx --target production` (con `--provenance=mode=max --sbom=true`) → push a repo `candidates` → `Trivy` + escaneo de secretos (`gitleaks`) → `cosign sign` sobre el digest → promoción por digest (`crane copy` / `imagetools create`) → deploy con `cosign verify` → smoke test → rollback al digest anterior si falla.

```bash
docker buildx build \
  --target production \
  --platform linux/amd64,linux/arm64 \
  --build-arg GIT_SHA="$GIT_SHA" \
  --cache-from type=registry,ref=$REG/recetaria-api:buildcache \
  --cache-to   type=registry,ref=$REG/recetaria-api:buildcache,mode=max \
  --provenance=mode=max --sbom=true \
  --tag $REG/recetaria-api-candidates:git-$SHORT_SHA \
  --push .

trivy image --exit-code 1 --severity CRITICAL,HIGH --ignore-unfixed \
  "$REG/recetaria-api-candidates@$DIGEST"

cosign sign --yes "$REG/recetaria-api-candidates@$DIGEST"
```

| Severidad CVE | Con fix disponible | Sin fix |
|---|---|---|
| **Critical** | Bloquea pipeline | Excepción documentada con vencimiento (VEX) |
| **High** | Bloquea (o SLA corto) | Excepción con vencimiento |
| **Medium / Low** | SLA de corrección | Seguimiento + rebuild semanal de base |

---

## 6. Batería de verificación previa a aprobar (§14)

```bash
docker build --check .
hadolint Dockerfile
docker compose -f compose.yaml config --quiet
docker run --rm --entrypoint id "$IMAGE"                              # uid != 0 (esperado: 1000)
docker run --rm --read-only --tmpfs /tmp "$IMAGE" node -e "process.exit(0)"
docker history --no-trunc "$IMAGE" | grep -iE 'secret|token|password' # salida vacía
docker inspect -f '{{.Config.User}} {{json .Config.Healthcheck}}' "$IMAGE"
trivy image "$IMAGE"
docker buildx imagetools inspect "$IMAGE" --format '{{json .Provenance}}'
docker compose up -d --wait && time docker compose stop api           # exit 0 dentro del grace period
docker compose ps --format '{{.Name}} {{.Ports}}'                     # sin puertos indeseados en 0.0.0.0
```

**Pruebas de fallo:** matar `api` (recuperación), reiniciar `postgres` (reconexión sin crash definitivo), omitir un secreto (fallo claro al arranque sin loguearlo), superar memoria (`OOMKilled` alertado), enviar `SIGTERM` con tráfico (0 requests cortados), ejecutar `down` + `up` (persistencia de `postgres_data`).

---

## 7. Antipatrones y Definition of Done

**Antipatrones:** correr como `root` · código escribible por la app (`--chown=node:node` en runtime) · `--privileged` · montar `docker.sock` · secretos en `ENV`/`ARG`/capas · `.env` commiteado · `COPY . .` antes de `npm ci` · `apt-get update` en capa separada · `curl` solo para healthcheck · `NODE_ENV=production` antes de `build` · tags `:latest` o bases sin digest · build en producción · `CMD` en forma shell o `npm start` como PID 1 · liveness acoplado a Postgres · creer que Docker reinicia `unhealthy` · publicar Postgres `5432` en `0.0.0.0` creyendo que UFW lo bloquea · `mem_limit` sin `--max-old-space-size` · logs sin rotación · firmar sin verificar.

**DoD:** imagen multi-stage reproducible desde CI con `.dockerignore` allowlist, base por digest, `USER node`, código read-only, 0 secretos en capas, healthcheck exec y graceful shutdown probado · runtime con `read_only` + `tmpfs` + `cap_drop: ALL` + `no-new-privileges` + `init` + límites + `--max-old-space-size` + red `data` `internal: true` + `*_FILE` + rotación `local` · pipeline con lint/tests/Trivy/SBOM/provenance/Cosign, deploy solo por pull de digest con `cosign verify` y rollback probado.
