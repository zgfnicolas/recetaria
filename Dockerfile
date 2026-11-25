# syntax=docker/dockerfile:1

# ==============================================================================
# Stage 1: Base Runtime (Node 24 LTS Bookworm Slim - glibc para bcrypt y Prisma 7)
# ==============================================================================
FROM node:24-bookworm-slim AS base

# OpenSSL y ca-certificates requeridos por el query engine de Prisma ORM
RUN apt-get update -y \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ==============================================================================
# Stage 2: Dependencies (Optimización de Build Cache con BuildKit)
# ==============================================================================
FROM base AS dependencies

COPY package.json package-lock.json prisma.config.ts ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci

# ==============================================================================
# Stage 3: Development (Entorno local con Hot-Reload vía tsx y usuario no-root)
# ==============================================================================
FROM dependencies AS development

ENV NODE_ENV=development
COPY --chown=node:node . .
# `.dockerignore` excluye `src/generated`: se genera el cliente de Prisma para que la imagen arranque
# sola. Con `docker:dev`, el montaje de ./src (solo lectura, hot-reload) usa el cliente del host.
RUN npx prisma generate \
 && chown -R node:node src/generated
USER node
EXPOSE 3000
CMD ["npm", "run", "dev"]

# ==============================================================================
# Stage 3b: Migrator (contenedor one-shot: `prisma migrate deploy` antes de la API, #24)
# ==============================================================================
# Lleva el CLI de Prisma y `tsx` (devDependencies) SIN contaminar la imagen de producción: el
# runtime no necesita privilegios DDL ni el CLI. Copia `src/` solo porque el seed (dev/test) lo importa.
FROM dependencies AS migrator

ENV CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src
RUN npx prisma generate
USER node
CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]

# ==============================================================================
# Stage 4: Build (Compilación de TypeScript ESM y purga de devDependencies)
# ==============================================================================
FROM dependencies AS build

COPY . .
RUN npm run build \
 && npm prune --omit=dev

# ==============================================================================
# Stage 5: Production Runtime (Artefacto mínimo, inmutable, solo lectura y No-Root)
# ==============================================================================
FROM base AS production

ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS="--max-old-space-size=384"

# Propiedad de root (sin --chown=node:node): USER node no puede modificar su propio código
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000

# Healthcheck en forma exec sin curl (liveness liviano en /health, sin consultar DB)
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "dist/server.js"]
