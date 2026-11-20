# Patrones SQL Relacionales para Recetaria API

Referencia técnica de [sql-relational-design](../SKILL.md) aplicada al dominio de Recetaria API ([database_schema_init.sql](../../../../database_schema_init.sql), [data_model.md](../../../../docs/data_model.md) y [business_rules.md](../../../../docs/business_rules.md)). Para internals específicos de PostgreSQL (MVCC, `EXPLAIN`, `GIN`, locks DDL y PITR), ver [postgresql-engineering](../../postgresql-engineering/SKILL.md).

---

## 1. Tipos recomendados y decisiones sobre el esquema actual

| Dato | Tipo estándar en Recetaria (PostgreSQL) | Notas y reglas |
|---|---|---|
| Identificador de entidad | `UUID DEFAULT gen_random_uuid()` | No enumerable; PK en `users`, `recipes`, `audit_logs` |
| ID secuencial (si aplica) | `BIGINT GENERATED ALWAYS AS IDENTITY` | Preferir ante tablas internas de alto volumen secuencial |
| Texto libre / acotado | `TEXT` o `VARCHAR(n)` solo si `n` es regla de dominio | `recipes.title VARCHAR(150)`, `recipes.description TEXT` |
| Estados / catálogos fijos | `ENUM` (`"Role"`, `"RecipeStatus"`, `"Difficulty"`) | Pasar a tabla catálogo si los valores crecen o llevan metadata |
| Rango numérico acotado | `SMALLINT` + `CHECK` | `chk_prep_time_positive CHECK ("prepTimeMinutes" > 0 AND "prepTimeMinutes" <= 1440)` (`RN-07`) |
| Cantidades exactas / dinero | `NUMERIC(12,2)` o entero en unidad mínima | Nunca `FLOAT` ni `REAL` |
| Instantes absolutos | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | Siempre en UTC (`"createdAt"`, `"updatedAt"`, `"publishedAt"`) |
| Fecha civil sin hora | `DATE` | Nunca guardar fechas en texto |
| Booleano | `BOOLEAN NOT NULL DEFAULT TRUE` | `users."isActive"` |
| Estructuras semi-estructuradas | `JSONB` con `CHECK` de forma mínima | `recipes.ingredients`, `recipes."nutritionalInfo"`, `audit_logs."oldValues"`/`"newValues"` |

### Auditoría rápida del esquema inicial de Recetaria

| Hallazgo en `database_schema_init.sql` | Impacto | Criterio para futuras evoluciones |
|---|---|---|
| `idx_users_email` e `idx_recipes_slug` duplican el índice creado por `UNIQUE` | Costo extra de escritura sin beneficio | En tablas/columnas nuevas, no crear `CREATE INDEX` redundante sobre una columna `UNIQUE` |
| `ON UPDATE CASCADE` en FKs hacia `users(id)` | Innecesario si `users.id` es `UUID` inmutable | Omitir `ON UPDATE CASCADE` en PKs surrogate inmutables |
| `audit_logs."entityId"` sin FK hacia `recipes(id)` | Excepción válida e intencional (`RN-06`) | Documentar siempre la excepción vía `COMMENT ON COLUMN` para que auditorías futuras no la "corrijan" |
| Columnas camelCase con comillas dobles (`"authorId"`) | Alineado a Prisma sin `@map`, pero exige comillas en SQL crudo | Mantener coherencia en consultas SQL crudas o adoptar `snake_case` + `@map` al introducir nuevas tablas |

---

## 2. Constraints y acciones referenciales

| Acción `ON DELETE` | Política en Recetaria | Ejemplo |
|---|---|---|
| `RESTRICT` / `NO ACTION` | Default para entidades maestras e históricas | `recipes."authorId"` → `users(id) ON DELETE RESTRICT` |
| `SET NULL` | Relación opcional cuya trazabilidad debe sobrevivir | `recipes."reviewedById"` y `audit_logs."userId"` → `ON DELETE SET NULL` |
| `CASCADE` | **Prohibido en tablas de negocio** ([database-migrations.md](../../../rules/database-migrations.md)) | Solo admisible en tablas puramente efímeras/auxiliares fuera de negocio |

```sql
-- Ejemplo de extensión futura N:M (ej. recetas <-> categorías si el producto evoluciona)
CREATE TABLE recipe_categories (
    recipe_id   UUID NOT NULL,
    category_id UUID NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_recipe_categories PRIMARY KEY (recipe_id, category_id),
    CONSTRAINT fk_recipe_categories_recipe FOREIGN KEY (recipe_id)
        REFERENCES recipes (id) ON DELETE RESTRICT,
    CONSTRAINT fk_recipe_categories_category FOREIGN KEY (category_id)
        REFERENCES categories (id) ON DELETE RESTRICT
);
-- La PK cubre búsquedas por recipe_id; indexar la segunda columna para búsquedas inversas y borrado de categorías:
CREATE INDEX idx_recipe_categories_category ON recipe_categories (category_id);
```

---

## 3. Patrones SQL correctos y sargables

### 3.1 `LEFT JOIN` sin romper opcionalidad y anti-join seguro con `NULL`
```sql
-- Correcto: filtrar la tabla derecha en el ON, no en el WHERE
SELECT u.id, u.email, r.id AS recipe_id
FROM users u
LEFT JOIN recipes r
  ON r."authorId" = u.id
 AND r.status = 'APPROVED';

-- Correcto: anti-join seguro frente a NULL (nunca NOT IN sobre subquery nullable)
SELECT u.id, u.email
FROM users u
WHERE NOT EXISTS (
  SELECT 1
  FROM recipes r
  WHERE r."authorId" = u.id
);
```

### 3.2 Rangos de fecha semiabiertos y sargabilidad
```sql
-- Correcto: usa índice sobre "createdAt"
SELECT id, "entityName", action, "createdAt"
FROM audit_logs
WHERE "createdAt" >= $1
  AND "createdAt" <  $2
ORDER BY "createdAt" DESC, id DESC;

-- Incorrecto (rompe uso de índice):
-- WHERE DATE_TRUNC('day', "createdAt") = $1
-- WHERE LOWER(email) = $1  (salvo que exista índice de expresión sobre lower(email))
```

### 3.3 Paginación keyset (feed público de recetas aprobadas)
Evita el costo lineal de `OFFSET` profundo ordenando siempre con desempate único (`id`):

```sql
SELECT id, title, slug, difficulty, "prepTimeMinutes", "publishedAt"
FROM recipes
WHERE status = 'APPROVED'
  AND ("publishedAt", id) < ($1, $2)
ORDER BY "publishedAt" DESC, id DESC
LIMIT 20;
-- Índice que la justifica:
-- CREATE INDEX idx_recipes_approved_feed
--   ON recipes ("publishedAt" DESC, id DESC) WHERE status = 'APPROVED';
```

### 3.4 Upsert e idempotencia (nunca `SELECT` y luego `INSERT`)
```sql
-- Unicidad respaldada por UNIQUE (email) + resolución atómica
INSERT INTO users (email, "passwordHash", "firstName", "lastName", role)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (email) DO NOTHING
RETURNING id, email, role;
```

---

## 4. Transacciones, anomalías y patrones de concurrencia

| Anomalía | Descripción | Mitigación principal |
|---|---|---|
| **Dirty read** | Leer datos no confirmados | Imposible en PostgreSQL (`READ COMMITTED` mínimo efectivo) |
| **Non-repeatable read** | Releer una fila modificada por otra tx | `REPEATABLE READ` o bloqueo explícito |
| **Phantom** | Nuevas filas aparecen en un mismo filtro | `REPEATABLE READ` / `SERIALIZABLE` |
| **Lost update** | Dos writers leen y uno pisa al otro | Update condicional, versión optimista o `FOR UPDATE` |
| **Write skew** | Dos tx validan una invariante global en filas distintas | `SERIALIZABLE` (SSI) o lock sobre entidad padre |

```sql
-- 1. Actualización condicional atómica (ejemplo: aprobar solo si sigue en DRAFT y no es el autor — RN-04/RN-05)
UPDATE recipes
SET status = 'APPROVED',
    "reviewedById" = $2,
    "publishedAt" = NOW()
WHERE id = $1
  AND status = 'DRAFT'
  AND "authorId" <> $2
RETURNING id, status, "reviewedById", "publishedAt";
-- 0 filas afectadas => diagnosticar si no existe (404), ya estaba APPROVED (409) o es auto-aprobación (403)

-- 2. Concurrencia optimista (útil si se agrega columna version a recipes)
UPDATE recipes
SET title = $2, status = 'DRAFT', version = version + 1
WHERE id = $1 AND version = $3;   -- 0 filas => 409 Conflict
```

- Mantener toda operación multi-paso (p. ej. `UPDATE/DELETE recipes` + `INSERT audit_logs` en `RN-06`) dentro de una sola transacción corta (`prisma.$transaction`) **sin llamadas HTTP ni I/O externo adentro**.
- Para prevenir deadlocks: actualizar múltiples filas en orden determinista por `id` y reintentar la transacción completa con backoff exponencial + jitter solo si la operación es idempotente.

---

## 5. Evolución zero-downtime (*Expand → Migrate → Contract*)

1. **Expand:** agregar nueva estructura compatible (columna nullable o tabla nueva) sin romper la versión en producción.
2. **Deploy dual:** la aplicación escribe en el esquema viejo y nuevo.
3. **Backfill:** migrar datos históricos en lotes pequeños por rango de PK con pausas.
4. **Switch:** mover lecturas a la nueva estructura.
5. **Contract:** eliminar lo viejo en un release posterior.

Antes de cualquier DDL, verificar lock y reescritura con [postgresql-engineering](../../postgresql-engineering/SKILL.md) y ejecutar la migración vía [db-migration](../../db-migration/SKILL.md) tras confirmación humana.

---

## 6. Antipatrones a rechazar en revisión

Tabla sin PK · relaciones solo en el ORM sin FK · `N:M` como CSV o array de IDs de entidades · JSONB reemplazando entidades con FK/unicidad · `FLOAT` para cantidades exactas/dinero · fechas en texto · `ON DELETE CASCADE` en tablas de negocio · `NULL` con múltiples significados · índice en cada columna o duplicando `UNIQUE` · tabla `N:M` sin índice en la segunda columna · "columna más selectiva primero" por dogma · optimizar sin plan real · `SELECT *` en producción · `DISTINCT` tapando un `JOIN` mal hecho · `NOT IN` sobre subquery nullable · filtro de `LEFT JOIN` en `WHERE` · funciones sobre columnas indexadas en `WHERE` · `OFFSET` profundo · `SELECT`-then-`INSERT` para unicidad · SQL concatenado · transacciones abiertas durante I/O externo · `ALTER` manual en producción.

---

## 7. Definition of Done

- **Modelo:** 100 % de tablas con PK; FKs o excepción documentada (`COMMENT ON`); cardinalidad/opcionalidad en `NOT NULL`/`UNIQUE`; sin `ON DELETE CASCADE` en negocio; revisado hasta 3NF; constraints nombradas explícitamente.
- **SQL y rendimiento:** 100 % parametrizado; queries críticas con plan real revisado; cada índice justificado por una query y sin duplicados; sin N+1; keyset en listados grandes.
- **Concurrencia:** operaciones multi-paso atómicas en transacciones cortas (especialmente `RN-06`); lost update cubierto y probado con concurrencia real; timeouts definidos.
- **Operación:** migraciones versionadas en repo; separación de roles; backups restaurados y verificados (ver [postgresql-engineering](../../postgresql-engineering/SKILL.md)).
