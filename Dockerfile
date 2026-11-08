# syntax=docker/dockerfile:1

# ==============================================================================
# Stage 1: Base Runtime (Debian Bookworm Slim - glibc para bcrypt y Prisma)
# ==============================================================================
FROM node:22.14.0-bookworm-slim AS base

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
# Stage 3: Development (Entorno local con Hot-Reload y usuario no-root)
# ==============================================================================
FROM dependencies AS development

ENV NODE_ENV=development
COPY --chown=node:node . .
USER node
EXPOSE 3000
CMD ["npm", "run", "dev"]

# ==============================================================================
# Stage 4: Build (Compilación de TypeScript y purga de devDependencies)
# ==============================================================================
FROM dependencies AS build

COPY . .
RUN npm run build \
 && npm prune --omit=dev

# ==============================================================================
# Stage 5: Production Runtime (Artefacto mínimo, inmutable y No-Root)
# ==============================================================================
FROM base AS production

ENV NODE_ENV=production \
    PORT=3000

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
