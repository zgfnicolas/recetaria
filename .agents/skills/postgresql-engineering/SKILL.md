---
name: postgresql-engineering
description: >-
  Diseña, revisa, optimiza, migra y opera PostgreSQL para Recetaria API (baseline
  PostgreSQL 15.12 con notas [PG17] y [PG18]) — tipos nativos y JSONB, índices B-tree/GIN/
  parciales/INCLUDE, EXPLAIN (ANALYZE, BUFFERS), MVCC y autovacuum, niveles de aislamiento,
  retries 40001/40P01, timeouts por rol, roles mínimos y RLS, migraciones DDL sin bloqueo
  (lock_timeout, NOT VALID, CONCURRENTLY), pooling con PgBouncer, observabilidad y backup/PITR.
  Usar ante DDL, queries lentas, locks, diseño de índices, Prisma + Postgres o backups.
---

# Ingeniería de PostgreSQL (Recetaria API)

Baseline: **PostgreSQL 15.12** en Recetaria API (`postgres:15.12-alpine` en [compose.yaml](../../../compose.yaml), esquema en [database_schema_init.sql](../../../database_schema_init.sql)). Las capacidades que requieren versiones posteriores se marcan explícitamente con `[PG17]` o `[PG18]` para planificar upgrades sin romper el entorno actual.
Prioridades: **Correctitud → Integridad → Seguridad → Recuperabilidad → Mantenibilidad → Observabilidad → Rendimiento → Escalabilidad**.

## 0. Modo de trabajo y reglas duras (MUST)

Antes de diseñar u optimizar, determiná: invariantes (`RN-01`–`RN-08`), límites transaccionales (`RN-06`), concurrencia, las 5–10 queries críticas con su SLO (p95/p99), volumen/retención y RPO/RTO.

**Formato de entrega:**
- **Esquema:** DDL ejecutable en PG 15 + tabla de decisiones + índices justificados por query real.
- **Query lenta:** plan `EXPLAIN (ANALYZE, BUFFERS)` → causa → cambio → verificación.
- **Migración:** script con `lock_timeout`, lock esperado, si reescribe tabla, backfill y rollback.

**Reglas duras:**
1. Toda tabla tiene `PK`; toda relación tiene `FK` o excepción documentada con `COMMENT ON` (caso `audit_logs."entityId"`).
2. Unicidad protegida con `UNIQUE` / índice único, nunca con `SELECT` previo.
3. Dinero/exactos en `numeric` o enteros en unidad mínima; eventos absolutos en `timestamptz`.
4. SQL siempre parametrizado; nunca concatenar input en `$queryRawUnsafe`.
5. En producción, la app nunca se conecta como superuser (`postgres`) ni como owner de las tablas.
6. Ningún DDL en producción sin `lock_timeout` y sin analizar el lock que toma.
7. `EXPLAIN (ANALYZE)` sobre `INSERT`/`UPDATE`/`DELETE` **solo** dentro de `BEGIN ... ROLLBACK`.
8. Nunca deshabilitar `autovacuum` globalmente; no usar `VACUUM FULL` como mantenimiento rutinario.
9. Una réplica no es un backup; un backup que no se restauró no es evidencia.

## 1. Tipos, JSONB e índices en PostgreSQL

- **Tipos:** `text` (o `varchar(n)` solo por regla de dominio), `timestamptz`, `uuid`, `boolean`, `numeric(p,s)`, `text[]`/`varchar(50)[]` para etiquetas sin identidad (`recipes.tags`), `ENUM` solo para dominios pequeños y estables (`"Role"`, `"RecipeStatus"`, `"Difficulty"`). `[PG18]` `uuid DEFAULT uuidv7()` mejora localidad B-tree respecto a `gen_random_uuid()` (UUIDv4), aunque expone timestamp.
- **Collations:** al migrar base de SO o imagen base (`alpine` vs `bookworm`), verificar cambios de collation (`glibc`/`musl`/ICU) y planificar `REINDEX` si cambian. Preferir proveedor ICU o `[PG17]` `builtin`.
- **JSONB (`recipes.ingredients`, `recipes."nutritionalInfo"`, `audit_logs."oldValues"`/`"newValues"`):**
  - Válido para estructuras variables o snapshots; si una clave se filtra siempre, ordena o requiere FK/unicidad, promoverla a columna.
  - Validar forma mínima con `CHECK (jsonb_typeof(ingredients) = 'array')`.
  - Índices según operador real: `GIN (col)` (`jsonb_ops`: `@>`, `?`, `?|`, `?&`), `GIN (col jsonb_path_ops)` (más compacto, solo `@>`/`jsonpath`), o B-tree de expresión sobre una clave fija.
- **Índices:** `B-tree` (`= < > ORDER BY`), `GIN` (`jsonb`, `tags`, full-text `tsvector`, `pg_trgm`), `GiST` (rangos/exclusión), `BRIN` (solo tablas enormes append-only correlacionadas como `audit_logs` histórico). Orden compuesto: **igualdad → orden → rango**. Crear índice en FKs usadas en `JOIN` o borrado del padre (PG no los crea automáticamente) y usar `CREATE INDEX CONCURRENTLY` en tablas grandes.

## 2. Diagnóstico, concurrencia y Prisma

- **Planner:** diagnosticar siempre con `EXPLAIN (ANALYZE, BUFFERS, SETTINGS)` (`[PG18]` incluye `BUFFERS` por defecto con `ANALYZE`). Orden: SLO (`pg_stat_statements`) → estimadas vs reales (`ANALYZE` / `CREATE STATISTICS`) → índices → spill a disco (`work_mem` local) → locks → bloat/autovacuum → N+1 → modelo.
- **Aislamiento y retries:** default `READ COMMITTED`; usar `REPEATABLE READ` o `SERIALIZABLE` (SSI) solo cuando la anomalía lo exija. Reintentar la transacción completa ante `40001` (`serialization_failure`) y `40P01` (`deadlock_detected`) con backoff + jitter. En Prisma (`prisma.$transaction`), mapear `P2002` (unique → `409`), `P2025` (not found → `404`), `P2003` (FK → `409`/`400`) y `P2034` (conflicto de transacción → retry).
- **Timeouts por rol:** configurar `statement_timeout` (ej. `5s`), `lock_timeout` (`2s`), `idle_in_transaction_session_timeout` (`30s`) y `[PG17]` `transaction_timeout`.

## 3. Seguridad, migraciones y operación

- **Roles:** separar `app_owner` (`NOLOGIN`), `app_migrator` (DDL), `app_runtime` (solo DML mínimo, sin `SUPERUSER`/`BYPASSRLS`/ownership) y `app_readonly`. *(Nota Recetaria: en `compose.yaml` local se usa `postgres`; en producción provisionar `app_runtime` + `app_migrator`.)*
- **Red:** `pg_hba.conf` con `hostssl` + `scram-sha-256` (`md5` deprecado `[PG18]`), cliente con `sslmode=verify-full`, red privada (`data: internal: true`).
- **DDL seguro:** `SET lock_timeout = '3s'`; FKs y checks con `NOT VALID` → `VALIDATE CONSTRAINT`; índices con `CONCURRENTLY`; cambios destructivos con *Expand → Migrate → Contract*.
- **Operación:** `autovacuum` activo y afinado por tabla caliente; pooling en la app o PgBouncer en `transaction mode` (usando `SET LOCAL`/`set_config(..., true)`); backup base + WAL continuo (PITR con `pgBackRest`/WAL-G o `[PG17]` `pg_basebackup --incremental`) y restores periódicos verificados.

## 4. Colaboración y delegación

| Necesidad | Skill |
|---|---|
| Modelado ER, 3NF, PK/FK, sargabilidad y SQL estándar | [sql-relational-design](../sql-relational-design/SKILL.md) |
| Cliente Prisma 7 (`PrismaPg`, pool, `$transaction`, mapeo `P2002`/`SQLSTATE`, Testcontainers) | [orm-persistence-js-ts](../orm-persistence-js-ts/SKILL.md) |
| Ejecutar `prisma validate`/`generate`/`migrate dev` tras confirmación | [db-migration](../db-migration/SKILL.md) |
| Contenedor `postgres`, volumen PG 15 vs PG 18, `shm_size`, `pg_isready` y secretos | [docker-production-containers](../docker-production-containers/SKILL.md) |
| Capa `repository.ts` como único punto de acceso a Prisma | [layered-architecture-ts](../layered-architecture-ts/SKILL.md) |

Para consultas de diagnóstico, tabla completa de locks DDL, roles/RLS, observabilidad (`pg_stat_*`), mantenimiento MVCC, PgBouncer, PITR y **Definition of Done**, consultá [references/postgres-patterns.md](./references/postgres-patterns.md).
