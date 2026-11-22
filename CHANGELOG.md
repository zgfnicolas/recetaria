# Changelog

Todos los cambios notables de este proyecto se documentarán en este archivo.

El formato está basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/),
y este proyecto adhiere a [Versionado Semántico](https://semver.org/lang/es/).

## [Sin publicar]

### Agregado
- Configuración nativa para Antigravity CLI en `.agents/` (reglas modulares, skills, subagentes, hooks `PreToolUse` y `mcp_config.json`), más `GEMINI.md` y `scripts/hooks/protect-files.mjs`.
- Registros de decisiones de arquitectura (`docs/adr/0000-template.md` y `0001` a `0004`).
- Plantillas de Pull Request, Issues y puntero `copilot-instructions.md` en `.github/`.
- Plantilla de permisos y sandbox recomendada en `docs/antigravity-settings.example.json`.
- Esquema Prisma 7 (`prisma/schema.prisma`) con `User`, `Recipe` y `AuditLog` sin `CASCADE`, y `prisma.config.ts`.
- Scripts `db:validate`, `db:format`, `db:generate` y `typecheck:test`; `prebuild`, `pretypecheck` y `pretest` generan el cliente de Prisma.
- Módulo singleton de persistencia (`src/infrastructure/database/prisma.ts`) con `pg.Pool`, adaptador `@prisma/adapter-pg`, exclusión por defecto de `passwordHash` (`omit`) y cierre ordenado `disconnect()`.
- Configuración de Vitest ESM (`vitest.config.ts`, `tsconfig.test.json`, `tests/setup/env.ts`) y prueba real de conectividad contra PostgreSQL 15 (`tests/integration/database/connectivity.test.ts`).
- Migración SQL inicial versionada de Prisma (`20261121201424_init`) con extensión `pgcrypto`, 4 restricciones `CHECK` en `recipes` (`chk_prep_time_positive`, `chk_recipes_reviewer_not_author`, `chk_recipes_ingredients_array`, `chk_recipes_nutritional_info_object`), triggers `BEFORE UPDATE` de `updatedAt` en `users`/`recipes` y `COMMENT ON COLUMN audit_logs."entityId"`.
- Suite de integración relacional contra PostgreSQL 15 (`tests/integration/database/relational-integrity.test.ts`: catálogo de motor, `P2002`, `omit` en runtime, los 4 `CHECK` en `INSERT`/`UPDATE`, triggers reales de `updatedAt`, `ON DELETE RESTRICT`/`SET NULL` y supervivencia en `audit_logs`).
- Script de seed idempotente en Prisma (`prisma/seed.ts`, alias `db:seed` vía `tsx`) para los 4 roles RBAC (`USER`, `CHEF`, `NUTRITIONIST`, `ADMIN`) con Bcrypt (`>= 10` rounds, `RN-08`), guarda *allowlist* para `NODE_ENV=development|test` y cierre ordenado de Prisma + `pg.Pool`.
- Suite de integración de repetibilidad del seed contra PostgreSQL 15 (`tests/integration/database/seed.test.ts`: roles, Bcrypt, idempotencia secuencial/parcial/concurrente, guarda de entorno, cero fugas en logs y cierre limpio del pool).
- Módulo de validación *fail fast* de entorno con Zod 4 (`src/config/env.ts`: `parseEnv`, `loadEnv`, objeto congelado `Env`, defaults `NODE_ENV=development`, `PORT=3000`, `JWT_EXPIRES_IN=1d` y cero fuga de secretos en mensajes de error).
- Jerarquía tipada de errores operacionales (`src/shared/errors/app-error.ts`: `AppError` compatible con `erasableSyntaxOnly` y `exactOptionalPropertyTypes`, `freezeErrorDetails` y subclases `BadRequestError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`, `ConflictError`, `ServiceUnavailableError`).
- Contrato **JSend extendido** (`src/shared/http/jsend.ts`: tipos discriminados, builders puros `buildSuccessResponse`/`buildErrorResponse` con `errors: []` por defecto, y emisores `sendSuccess`/`sendError`).
- Suites unitarias en Vitest junto al código fuente (`src/config/env.test.ts`, `src/shared/errors/app-error.test.ts`, `src/shared/http/jsend.test.ts`: 93 pruebas unitarias).
- Fábrica de aplicación Express 5 (`src/app.ts`: `buildApp` sin `listen()`, endurecimiento `x-powered-by` deshabilitado, `query parser` `"simple"`, `trust proxy` explícito, CORS por defecto inmutable sin arreglos compartidos, límites `100kb` en JSON/URL-encoded y montaje validado de routers bajo `/api/v1`).
- Middlewares transversales HTTP (`src/middlewares/logger.middleware.ts` con sanitización C0/C1/CRLF/Unicode y redacción de query keys sensibles; `src/middlewares/validate.middleware.ts` con Zod 4, `req.valid`, tipo auxiliar `ValidatedRequest` y expansión BOPLA `unrecognized_keys`; `src/middlewares/not-found.middleware.ts`; `src/middlewares/error-handler.middleware.ts` de 4 parámetros mapeando `entity.parse.failed`, `request.aborted`, `entity.too.large`, `parameters.too.many`, `ZodError`, `AppError` —redactando también `statusCode === 500`—, `P2002`, `P2025` y fallback `500` a JSend).
- Pruebas unitarias de middlewares (`src/middlewares/logger.middleware.test.ts` [7], `validate.middleware.test.ts` [9], `not-found.middleware.test.ts` [1], `error-handler.middleware.test.ts` [16]) y suite base de integración HTTP con Supertest sobre `buildApp` (`tests/integration/http/app.test.ts` [17]: 50 pruebas nuevas).
- Sondas de salud operativas separadas en `src/shared/http/health.router.ts` (`GET /health` liveness puro sin acceso a DB y `GET /health/ready` readiness con `SELECT 1` sobre PostgreSQL, coalescencia *single-flight* ante ráfagas concurrentes y timeout acotado de `2000ms`), montadas en `src/app.ts` antes de parsers y autenticación con `Cache-Control: no-store` y respuestas en sobre JSend extendido (`200` / `503` redactado).
- Servidor HTTP ejecutable con apagado ordenado en `src/server.ts` → `dist/server.js` (`applyServerTimeouts` con `keepAliveTimeout: 65s`, `headersTimeout: 66s` y `requestTimeout: 30s`; `createDrainingHttpServer` + `createGracefulShutdown` idempotente con drenaje de conexiones `keep-alive` en curso mediante `Connection: close` + `closeIdleConnections()`, propagación de fallos fatales durante el drenaje hacia código `1`, corte forzado en `10s` con `closeAllConnections()`, limpieza del singleton Prisma + `pg.Pool` vía `disconnect()`, manejo de `SIGTERM`/`SIGINT`/`uncaughtException`/`unhandledRejection`/`server.on("error")` y guarda `isMainModule()`).
- Pruebas unitarias y de integración HTTP de sondas y servidor (`src/shared/http/health.router.test.ts` [13], `src/server.test.ts` [18] y `tests/integration/http/health.test.ts` [5] contra PostgreSQL 15 en Docker y subproceso `isMainModule()`: 36 pruebas nuevas).
- `docs/dependency-overrides.md` con el override de `effect` (GHSA-7589-6fvf-x4pw).

### Cambiado
- Reestructuración plana de `docs/` (`prd.md`, `roles.md`, `business_rules.md`, `sad.md`, `data_model.md`, `roadmap.md`, `testing.md`, `compliance.md`, `plans/`).
- Unificación de requisitos del producto y requisitos no funcionales en `docs/prd.md`.
- Simplificación de `README.md`, `CONTRIBUTING.md`, `AGENTS.md` y `CLAUDE.md` (`@AGENTS.md`).
- Licencia formal en `LICENSE` (MIT) alineada con `package.json`.
- `vitest` actualizado a `^5.1.1` para corregir advisories de `tinypool` y `@vitest/mocker`.
- `compose.override.yaml`: `networks.data.internal: false` solo en desarrollo para que Docker Engine 28+/29 publique los puertos locales en `127.0.0.1` (`postgres` y `adminer`), manteniendo `compose.yaml` endurecido en producción; retirado el montaje `01-init.sql` de `database_schema_init.sql` para que las migraciones de Prisma gestionen el esquema desde cero.
- `vitest.config.ts`: habilitado `fileParallelism: false` para aislar `TRUNCATE` entre suites de integración sobre PostgreSQL compartido.
- `docs/data_model.md`: actualizado para reflejar las migraciones SQL de Prisma como fuente DDL operativa junto a `prisma/schema.prisma` y documentar las 4 restricciones `CHECK`.
- `tsconfig.test.json`: incluye `prisma/seed.ts` dentro de la verificación estricta `typecheck:test`; actualizados `docs/data_model.md`, `docs/prd.md` y `README.md` con el flujo de seed en Prisma.
- `tsconfig.json` y `tsconfig.test.json`: excluido `src/**/*.test.ts` de la compilación productiva (`dist/`) manteniendo la verificación estricta de todas las pruebas en `typecheck:test`.
- `src/infrastructure/database/prisma.ts`: `getDatabase(connectionString?: string)` acepta opcionalmente la URL validada por `loadEnv()` manteniendo compatibilidad con invocaciones sin argumentos.
- `src/app.ts`: `BuildAppOptions` incorpora `prisma` (`ReadinessDatabaseClient`) y `readinessTimeoutMs`, montando las sondas de salud entre CORS y los body parsers.

### Eliminado
- Archivos redundantes en la raíz (`llm.txt`, `llms-full.txt`, `architecture.md`, `instructions.md`, `CLAUDE.local.md`, `.mcp.json`, `LICENSE.md`).
- Documento duplicado `docs/srs.md` y carpetas obsoletas `.ai/`, `.claude/`, `.cursor/`, `.devin/`.

## [0.1.0] - 2026-11-07

### Agregado
- Arquitectura inicial de contenedores Docker multi-stage (`Dockerfile`, `compose.yaml`, `compose.override.yaml` y `.dockerignore`).
- Esquema SQL inicial de PostgreSQL 15 en `database_schema_init.sql` (`users`, `recipes`, `sessions`, `audit_logs`).
- Documentación fundacional del MVP Backend de Recetaria API y plantilla `.env.example`.
