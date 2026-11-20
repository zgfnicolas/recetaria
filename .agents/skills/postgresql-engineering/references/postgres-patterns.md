# Patrones de Ingeniería PostgreSQL para Recetaria API

Referencia técnica de [postgresql-engineering](../SKILL.md) sobre la baseline **PostgreSQL 15.12** de Recetaria API ([database_schema_init.sql](../../../../database_schema_init.sql), [compose.yaml](../../../../compose.yaml)), con marcadores `[PG17]` y `[PG18]` para planificación de upgrades. Ver también [sql-relational-design](../../sql-relational-design/SKILL.md) y [docker-production-containers](../../docker-production-containers/SKILL.md).

---

## 1. Índices en Recetaria API: estado actual y evolución

Estado actual en `database_schema_init.sql`:
- `users`: `PK(id)`, `UNIQUE(email)`, `idx_users_role_isactive(role, "isActive")` *(nota: `idx_users_email` es redundante con `UNIQUE(email)`)*.
- `recipes`: `PK(id)`, `UNIQUE(slug)`, `idx_recipes_authorid("authorId")`, `idx_recipes_status_difficulty(status, difficulty)` *(nota: `idx_recipes_slug` es redundante con `UNIQUE(slug)`)*.
- `audit_logs`: `PK(id)`, `idx_audit_logs_entity("entityName", "entityId")`, `idx_audit_logs_createdat("createdAt")`.

Candidatos de índices cuando crezca el tráfico (crear siempre con `CONCURRENTLY` y verificar con `EXPLAIN`):

```sql
-- 1. Feed público paginado por keyset (solo recetas APPROVED)
CREATE INDEX CONCURRENTLY idx_recipes_approved_published
  ON recipes ("publishedAt" DESC, id DESC)
  WHERE status = 'APPROVED';

-- 2. Búsqueda case-insensitive de email si se normaliza en consulta
CREATE UNIQUE INDEX CONCURRENTLY uq_users_email_lower
  ON users (lower(email));

-- 3. Filtrado por etiquetas (recipes.tags es VARCHAR(50)[])
CREATE INDEX CONCURRENTLY idx_recipes_tags_gin
  ON recipes USING GIN (tags);

-- 4. Búsqueda por ingrediente dentro de JSONB usando operador @>
CREATE INDEX CONCURRENTLY idx_recipes_ingredients_gin
  ON recipes USING GIN (ingredients jsonb_path_ops);

-- 5. Validación mínima de forma en JSONB (agregar vía NOT VALID -> VALIDATE)
ALTER TABLE recipes
  ADD CONSTRAINT chk_recipes_ingredients_array
  CHECK (jsonb_typeof(ingredients) = 'array' AND jsonb_array_length(ingredients) > 0) NOT VALID;
ALTER TABLE recipes VALIDATE CONSTRAINT chk_recipes_ingredients_array;
```

---

## 2. Planner y diagnóstico de queries lentas

```sql
-- Lectura: incluye buffers reales y configuración efectiva
EXPLAIN (ANALYZE, BUFFERS, SETTINGS)
SELECT id, title, slug, difficulty, "prepTimeMinutes"
FROM recipes
WHERE status = 'APPROVED' AND difficulty = 'EASY'
ORDER BY "publishedAt" DESC, id DESC
LIMIT 20;

-- DML: siempre dentro de BEGIN ... ROLLBACK porque ANALYZE ejecuta la sentencia
BEGIN;
EXPLAIN (ANALYZE, BUFFERS)
UPDATE recipes SET status = 'DRAFT' WHERE id = '...';
ROLLBACK;
```

**Checklist en orden (no arrancar por "subir RAM"):**
1. SLO y frecuencia en `pg_stat_statements` (`total_exec_time`, `calls`, `mean_exec_time`, `rows`).
2. Estimadas vs reales: desvíos ×10 → correr `ANALYZE`, `SET STATISTICS` o `CREATE STATISTICS (dependencies, ndistinct, mcv)`.
3. Evaluar si un `Seq Scan` es correcto (cuando lee >5–10 % de la tabla suele ganar al índice).
4. Comprobar si falta índice o si el orden compuesto no calza con `WHERE`/`ORDER BY`.
5. Sort/Hash con spill a disco (`external merge`, `Batches > 1`) → subir `work_mem` por rol o sesión, nunca global sin medir.
6. `shared read` alto → I/O; `Rows Removed by Filter` alto → índice subóptimo.
7. Locks esperando (`pg_stat_activity.wait_event_type = 'Lock'`).
8. Bloat / `autovacuum` atrasado.
9. N+1 desde la capa de repositorio/Prisma.
10. Revisar si el cuello de botella es la query o el diseño del modelo.

---

## 3. Concurrencia, timeouts y patrones transaccionales

### 3.1 Timeouts obligatorios por rol
```sql
ALTER ROLE app_runtime SET statement_timeout = '5s';
ALTER ROLE app_runtime SET lock_timeout = '2s';
ALTER ROLE app_runtime SET idle_in_transaction_session_timeout = '30s';
-- [PG17] ALTER ROLE app_runtime SET transaction_timeout = '15s';
```

### 3.2 Niveles de aislamiento y retries
- `READ COMMITTED` (default): snapshot por sentencia; suficiente para casi todo el MVP de Recetaria combinado con `WHERE` condicional y `prisma.$transaction`.
- `REPEATABLE READ`: snapshot por transacción; útil en reportes consistentes (puede fallar con `40001`).
- `SERIALIZABLE` (SSI): invariantes entre múltiples filas imposibles de bloquear puntualmente (aborta con `40001`).
- **Retry:** reintentar la transacción **completa** ante `40001` (`serialization_failure`) o `40P01` (`deadlock_detected`) con backoff exponencial + jitter y tope de intentos; jamás reintentar sentencias sueltas dentro de una transacción ya abortada.

### 3.3 Patrones idiomáticos de PostgreSQL
```sql
-- Bloqueo pesimista sin bloquear FKs cuando no cambia la PK
SELECT id, status, "authorId"
FROM recipes
WHERE id = $1
FOR NO KEY UPDATE;

-- Cola de trabajos concurrente (si en el futuro se agrega outbox/jobs en PG)
SELECT id
FROM outbox_jobs
WHERE status = 'PENDING'
ORDER BY "createdAt"
LIMIT 10
FOR UPDATE SKIP LOCKED;

-- Lock distribuido ligero para cron/job único (se libera al cerrar la tx)
SELECT pg_try_advisory_xact_lock(hashtext('recetaria-nightly-audit-export'));

-- [PG18] RETURNING old.*, new.* permite capturar estado previo y nuevo en una sola sentencia
-- útil para simplificar auditoría (RN-06) al actualizar a PG 18.
```

---

## 4. Migraciones seguras y tabla de locks DDL

| Operación DDL | Lock / costo en PG 15+ | Forma segura |
|---|---|---|
| `ADD COLUMN` nullable o default constante | `ACCESS EXCLUSIVE` breve, sin reescritura | Seguro con `lock_timeout` corto |
| `ADD COLUMN` default volátil (`clock_timestamp()`) | Reescribe la tabla completa | Agregar nullable + backfill en lotes |
| `ALTER COLUMN TYPE` | Casi siempre reescribe + reindexa | *Expand → Migrate → Contract* |
| `SET NOT NULL` | Escaneo completo con `ACCESS EXCLUSIVE` | `CHECK (c IS NOT NULL) NOT VALID` → `VALIDATE` → `SET NOT NULL` → drop check (`[PG18]` `NOT NULL NOT VALID` directo) |
| `ADD FOREIGN KEY` | `SHARE ROW EXCLUSIVE` en ambas tablas | `ADD ... NOT VALID` → `VALIDATE CONSTRAINT` |
| `ADD UNIQUE` / `PK` | Bloquea escrituras mientras arma índice | `CREATE UNIQUE INDEX CONCURRENTLY` → `ADD CONSTRAINT ... USING INDEX` |
| `CREATE INDEX` | `SHARE` (bloquea escrituras) | `CREATE INDEX CONCURRENTLY` (fuera de tx; si falla queda `INVALID`: dropear y reintentar) |
| `DROP COLUMN` | `ACCESS EXCLUSIVE` breve | Quitar primero toda referencia en la app |

```sql
-- Plantilla de migración segura (recordar: un ACCESS EXCLUSIVE esperando bloquea a todos detrás)
SET lock_timeout = '3s';
SET statement_timeout = '0';

ALTER TABLE recipes
  ADD CONSTRAINT fk_recipes_reviewer
  FOREIGN KEY ("reviewedById") REFERENCES users (id) ON DELETE SET NULL NOT VALID;

ALTER TABLE recipes VALIDATE CONSTRAINT fk_recipes_reviewer;
```

---

## 5. Seguridad: roles mínimos, red y RLS

```sql
-- Separación de roles recomendada para staging/producción (no usar superuser postgres en app)
CREATE ROLE recetaria_owner    NOLOGIN;
CREATE ROLE recetaria_migrator LOGIN IN ROLE recetaria_owner;
CREATE ROLE recetaria_runtime  LOGIN;
CREATE ROLE recetaria_readonly NOLOGIN;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO recetaria_runtime, recetaria_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO recetaria_runtime;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO recetaria_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE recetaria_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO recetaria_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE recetaria_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO recetaria_readonly;
```

- **Funciones `SECURITY DEFINER`:** fijar siempre `SET search_path = pg_catalog, pg_temp` y ejecutar `REVOKE EXECUTE ... FROM PUBLIC`.
- **Red:** `pg_hba.conf` con `hostssl` + `scram-sha-256`; cliente con `sslmode=verify-full` (`require` cifra pero no verifica identidad del servidor).
- **RLS (si en el futuro Recetaria se vuelve multi-tenant):** habilitar `ENABLE` + `FORCE ROW LEVEL SECURITY`, evaluar `NULLIF(current_setting('app.tenant_id', true), '')::uuid` (fail-closed) y setear por transacción con `SELECT set_config('app.tenant_id', $1, true)` (compatible con PgBouncer `transaction mode`).

---

## 6. Mantenimiento MVCC, pooling, observabilidad y backup/PITR

- **MVCC y Autovacuum:** ajustar por tabla en tablas de alta escritura (`ALTER TABLE recipes SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);`). Evitar transacciones largas, `idle in transaction` y slots abandonados que frenan `VACUUM` y elevan el riesgo de XID wraparound. Usar `fillfactor < 100` en tablas con muchos `UPDATE` para favorecer HOT updates.
- **Conexiones y PgBouncer:** dimensionar el pool de Prisma con medición (`≈ 2–4 × vCPU` como punto de partida); con PgBouncer en `transaction mode`, evitar `SET` de sesión, tablas temporales y advisory locks de sesión.
- **Backup y PITR:** `pg_dump` sirve para backups lógicos y migraciones, pero no reemplaza PITR. Para producción: backup base + archivo WAL continuo (`pgBackRest` / `WAL-G`; `[PG17]` `pg_basebackup --incremental` + `pg_combinebackup`) y pruebas periódicas automatizadas de restore + smoke test midiendo RTO real.
- **Upgrade de versión mayor (ej. PG 15 → PG 17/18):** ensayar en staging con `pg_upgrade` (`[PG18]` conserva estadísticas del planner) o replicación lógica; revisar el cambio de ruta de volumen en contenedor (`/var/lib/postgresql/data` en PG ≤ 17 vs `/var/lib/postgresql` en PG 18+) en [docker-production-containers](../../docker-production-containers/SKILL.md).

### Consultas mínimas de observabilidad
```sql
-- Transacciones largas o idle in transaction
SELECT pid, usename, state, now() - xact_start AS dur, left(query, 80)
FROM pg_stat_activity
WHERE xact_start < now() - interval '5 min'
ORDER BY dur DESC;

-- Tablas con más tuplas muertas y último autovacuum
SELECT relname, n_dead_tup, n_live_tup, last_autovacuum
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 20;

-- Índices sin uso (evaluar tras período representativo y revisando réplicas)
SELECT indexrelid::regclass, idx_scan, pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_stat_user_indexes
WHERE idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC;

-- Edad de XID (wraparound)
SELECT datname, age(datfrozenxid) FROM pg_database ORDER BY 2 DESC;
```

---

## 7. Testing y Definition of Done

- **Testing:** ejecutar tests de esquema, constraints y concurrencia (2+ conexiones simultáneas probando `UNIQUE`, lost update, deadlocks y `40001`) contra un **PostgreSQL real** (Docker Compose o Testcontainers), nunca contra motores embebidos o mocks en memoria.
- **Orden de escalabilidad:** queries → índices → esquema → autovacuum → configuración medida (`shared_buffers`, `work_mem`, checkpoints) → pooling → vertical → caché con invalidación → réplicas de lectura → particionamiento (solo por retención/pruning real, ej. `audit_logs` histórico).
- **DoD verificable:** 100 % PK + FK/excepción en `COMMENT ON` · índices ligados a queries sin duplicados · top queries con `EXPLAIN (ANALYZE, BUFFERS)` y SLO · `statement_timeout`/`lock_timeout`/`idle_in_transaction_session_timeout` activos · retries `40001`/`40P01` donde aplica · `app_runtime` sin superuser ni ownership · `hostssl` + `scram-sha-256` + `verify-full` · `pg_stat_statements` y `autovacuum` monitoreados · backup + PITR con restore probado.
