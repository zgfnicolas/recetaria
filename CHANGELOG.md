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

### Eliminado
- Archivos redundantes en la raíz (`llm.txt`, `llms-full.txt`, `architecture.md`, `instructions.md`, `CLAUDE.local.md`, `.mcp.json`, `LICENSE.md`).
- Documento duplicado `docs/srs.md` y carpetas obsoletas `.ai/`, `.claude/`, `.cursor/`, `.devin/`.

## [0.1.0] - 2026-11-07

### Agregado
- Arquitectura inicial de contenedores Docker multi-stage (`Dockerfile`, `compose.yaml`, `compose.override.yaml` y `.dockerignore`).
- Esquema SQL inicial de PostgreSQL 15 en `database_schema_init.sql` (`users`, `recipes`, `sessions`, `audit_logs`).
- Documentación fundacional del MVP Backend de Recetaria API y plantilla `.env.example`.
