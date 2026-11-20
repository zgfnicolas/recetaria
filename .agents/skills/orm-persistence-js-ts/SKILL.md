---
name: orm-persistence-js-ts
description: >-
  Configura, implementa, revisa y opera la capa de persistencia Prisma ORM + PostgreSQL 15+
  en TypeScript para Recetaria API — alineación Prisma 7 GA con @prisma/adapter-pg,
  singleton en composition root, presupuesto de pool y PgBouncer, repositorios L1/L2 sin
  mass assignment ni N+1, transacciones interactivas ACID (RN-06), mapeo de errores
  Prisma (P2002/P2025/P2034) y SQLSTATE a AppError/JSend con retry 40001/40P01, TypedSQL,
  migraciones seguras (migrate dev --create-only / migrate deploy en job), observabilidad
  y testing contra PostgreSQL real. Usar al configurar Prisma, escribir repositorios,
  manejar errores/transacciones DB o diseñar jobs de migración.
---

# Persistencia ORM en TypeScript (Prisma + PostgreSQL — Recetaria API)

Baseline: **Prisma ORM 7 GA** (`@prisma/client` + `@prisma/adapter-pg`) sobre **PostgreSQL 15.12** en la capa `src/modules/*/repository.ts` de Recetaria API ([AGENTS.md](../../../AGENTS.md), [database_schema_init.sql](../../../database_schema_init.sql)).
Prioridades: **Integridad → Seguridad → Correctitud → Migrabilidad → Observabilidad → Performance → Simplicidad**.

> [!WARNING]
> **Desalineamiento actual en [package.json](../../../package.json) y [prisma.config.ts](../../../prisma.config.ts):** el repo declara `@prisma/client@^7.10.1` en `dependencies`, `prisma@^8.0.0-rc.33` en `devDependencies` (major 8 RC, API incompatible con v7) y `definePrismaConfig` sin `@prisma/adapter-pg`. Antes de generar el cliente o migraciones, alinear con confirmación explícita a **Prisma 7 GA fijado** (`prisma@~7` + `@prisma/client@~7` + `@prisma/adapter-pg`) o migrar a Prisma 8 solo tras su GA oficial.

## 0. Modo de trabajo y reglas duras (MUST)

Antes de escribir código de persistencia, leer siempre `package.json` y `package-lock.json` para confirmar la versión real instalada, el dueño del esquema (`prisma/schema.prisma`), el presupuesto de pool y el rol de DB.

**Reglas duras:**
1. Nunca mezclar APIs ni binarios de majors distintos (`prisma` y `@prisma/client` siempre en el mismo major fijado; nunca `npx prisma@latest`).
2. `PrismaClient` vive **solo** en la capa de persistencia (`src/infrastructure/database/prisma.ts` + `src/modules/*/repository.ts`), inyectado desde el composition root (`src/bootstrap/container.ts`).
3. Prohibido `prisma migrate dev` y `prisma db push` en producción: aplicar siempre `prisma migrate deploy` en un job único previo al rollout.
4. Prohibido `$queryRawUnsafe` y `$executeRawUnsafe` con input externo; usar API tipada, `TypedSQL` o `$queryRaw` con tagged template + `Prisma.join`.
5. Cero mass assignment (`data: req.body` prohibido): construir escrituras campo a campo desde DTOs Zod validados.
6. Ocultar secretos por defecto (`omit: { user: { passwordHash: true } }`) y usar proyección explícita (`select`) en endpoints.
7. Nunca exponer mensajes crudos de Prisma/PostgreSQL ni SQL con parámetros al cliente HTTP ni a los logs productivos.
8. Un único dueño del esquema (`prisma/schema.prisma`); prohibido `onDelete: Cascade` en tablas de negocio ([database-migrations.md](../../rules/database-migrations.md)).

## 1. Cliente Prisma 7, pooling y fronteras

- **Configuración Prisma 7:** `prisma.config.ts` con `defineConfig` separando `MIGRATION_DATABASE_URL` (rol DDL `recetaria_migrator`) de `DATABASE_URL` (rol DML `recetaria_runtime`), usada en runtime por `PrismaPg` (`@prisma/adapter-pg`) con `max`, `connectionTimeoutMillis`, `idleTimeoutMillis` y `statement_timeout`.
- **Presupuesto de conexiones:** `réplicas_max × pool_max + jobs_migración + admin ≤ max_connections × 0.8`. En proceso long-running: un único singleton por proceso cerrado únicamente en `SIGTERM`/`SIGINT` (`prisma.$disconnect()`).
- **Pooler en `transaction mode` (PgBouncer):** sin estado de sesión persistente; migraciones siempre por conexión directa.
- **Hot paths / reportes complejos:** complementar Prisma con `TypedSQL` (`prisma/sql/*.sql` + `prisma generate --sql`) o `$queryRaw` parametrizado (o `pg` directo solo con cuello de botella medido), respetando el mismo presupuesto de pool.

## 2. Transacciones (`RN-06`), errores y seguridad

- **Transacciones cortas:** toda mutación con auditoría (`APPROVE`, `RESET_TO_DRAFT`, `DELETE` según `RN-06`) corre dentro de `prisma.$transaction(async (tx) => ..., { timeout: 5_000 })` **sin llamadas HTTP, emails ni colas adentro**.
- **Concurrencia:** `READ COMMITTED` + `UPDATE` condicional atómico (o versión optimista) cubre el MVP; reintentar la transacción completa con backoff exponencial + jitter ante `P2034` / `40001` (`serialization_failure`) / `40P01` (`deadlock_detected`).
- **Traducción de errores en el repositorio:** mapear códigos Prisma (`P2002` → `409 Conflict`, `P2025` → `404 Not Found`, `P2003` → `409`/`400`, `P2034` → retry/`409`) y `SQLSTATE` (`23505`, `23503`, `23514`, `55P03`/`57014` → `503`) a subclases de `AppError` → sobre JSend.
- **Queries eficientes:** proyección explícita, paginación keyset (`ORDER BY "createdAt" DESC, id DESC`), sin N+1, `orderBy` dinámico siempre por allowlist, y validación Zod sobre columnas `JSONB` (`ingredients`, `nutritionalInfo`).
- **RLS (post-MVP multi-tenant):** fijar `set_config('app.tenant_id', ..., true)` dentro de la **misma** transacción interactiva (no vía `$extends` con transacción aparte).

## 3. Migraciones, observabilidad y testing

- **Flujo seguro:** `npx prisma migrate dev --create-only` → auditar el SQL generado (reemplazar `DROP + ADD` por `RENAME COLUMN`, añadir `SET lock_timeout`, `NOT VALID` / `CONCURRENTLY` en tablas grandes) → aplicar con confirmación humana; en CI validar drift con `prisma migrate diff`; en despliegue correr `prisma migrate deploy` en un job único antes de subir las réplicas de la API.
- **Observabilidad:** instrumentar con OpenTelemetry (`@prisma/instrumentation` / `@opentelemetry/instrumentation-pg`); monitorear queries por request (detecta N+1), latencia p95/p99, espera de pool y errores por código/`SQLSTATE`.
- **Testing:** ejecutar tests de repositorio e integración contra un **PostgreSQL 15 real** (Docker Compose o Testcontainers con el mismo major que producción), probando `P2002`, rollback de `RN-06`, concurrencia/lost update y retry `P2034`/`40001`.

## 4. Colaboración y delegación

| Necesidad | Skill |
|---|---|
| Diseño ER/3NF, constraints, sargabilidad, keyset y concurrencia SQL | [sql-relational-design](../sql-relational-design/SKILL.md) |
| Internals PostgreSQL (`EXPLAIN`, índices GIN/parciales, locks DDL, MVCC, roles/RLS, PITR) | [postgresql-engineering](../postgresql-engineering/SKILL.md) |
| Contenedor Postgres, secretos `*_FILE`, red `data` y jobs de deploy | [docker-production-containers](../docker-production-containers/SKILL.md) |
| Runbook operativo seguro de Prisma CLI (`validate`/`generate`/`migrate`) | [db-migration](../db-migration/SKILL.md) |
| Frontera de 4 capas (`repository.ts`), `AppError` y composition root | [layered-architecture-ts](../layered-architecture-ts/SKILL.md) |
| Tipado fuerte TS 7 (`erasableSyntaxOnly`, branded types, `Result`, Big-O, ESLint) | [typescript-engineering](../typescript-engineering/SKILL.md) |
| Estrategia de testing P0, oráculos, sensibilidad, Vitest + Supertest + `Stryker` | [critical-path-testing](../critical-path-testing/SKILL.md) |
| Manejo async, `SIGTERM` y graceful shutdown en Node.js | [node-backend-engineering](../node-backend-engineering/SKILL.md) |
| Lockfiles, scripts de instalación (`allowScripts`) y CI GitHub Actions | [js-project-configuration](../js-project-configuration/SKILL.md) |

Para código completo de `prisma.config.ts`, `schema.prisma` de Recetaria, singleton `PrismaPg`, mapeador `db-errors.ts` + `withRetry`, transacción `RN-06`, Testing con Testcontainers, evolución de ORM, antipatrones y **Definition of Done**, consultá [references/prisma-patterns.md](./references/prisma-patterns.md).
