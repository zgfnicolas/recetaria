---
name: sql-relational-design
description: >-
  Modela, escribe, revisa y evoluciona esquemas y consultas SQL relacionales para Recetaria
  API sobre PostgreSQL 15+ y Prisma — modelado ER, normalización 3NF/BCNF, PK/FK/NULL,
  constraints e integridad referencial sin CASCADE en tablas de negocio, SQL sargable,
  JOINs, CTEs, paginación keyset, índices compuestos, transacciones ACID y prevención de
  lost update/deadlocks. Usar al diseñar tablas o relaciones, escribir o auditar SQL,
  revisar consultas lentas o planificar cambios de esquema.
---

# Diseño SQL Relacional (Recetaria API)

Baseline: SQL estándar (ISO/IEC 9075) aplicado a **PostgreSQL 15+** y **Prisma ORM** en Recetaria API (`users`, `recipes`, `audit_logs` en [database_schema_init.sql](../../../database_schema_init.sql) y [data_model.md](../../../docs/data_model.md)).
Prioridades: **Correctitud → Integridad → Seguridad → Recuperabilidad → Mantenibilidad → Rendimiento**.

## 0. Modo de trabajo y reglas duras (MUST)

Antes de escribir DDL o SQL, fijá: entidades e identidad, cardinalidad/opcionalidad, invariantes de negocio (`RN-01`–`RN-08`), queries críticas con volumen esperado, concurrencia y accesos. Si faltan datos de bajo riesgo, asumí, declaralo explícitamente y avanzá.

**Formato de entrega:**
- **Esquema:** DDL ejecutable + tabla de decisiones (*decisión / alternativa / motivo*) + índices ligados a su query real.
- **Query:** SQL parametrizado + motivo de la forma elegida + cómo verificar el plan.
- **Revisión:** hallazgos por severidad (*integridad/seguridad > concurrencia > rendimiento > estilo*).

**Reglas duras:**
1. Toda tabla de entidad tiene `PK`; toda relación tiene `FK` o excepción documentada (en Recetaria, `audit_logs."entityId"` omite FK a `recipes` para conservar la trazabilidad tras `DELETE` físico — `RN-06`).
2. Prohibido `ON DELETE CASCADE` en tablas de negocio ([database-migrations.md](../../rules/database-migrations.md)): usar `RESTRICT` (como `recipes."authorId"`) o `SET NULL` (como `recipes."reviewedById"` y `audit_logs."userId"`).
3. Claves de negocio protegidas con `UNIQUE` en la base (`users.email`, `recipes.slug`), nunca con `SELECT` previo.
4. Cantidades exactas o dinero en `NUMERIC(p, s)` o entero en unidad mínima; nunca `FLOAT`/`REAL`.
5. Instantes absolutos en `TIMESTAMPTZ` (UTC); nunca fechas como texto.
6. SQL 100 % parametrizado (`$1`, `$2` o Prisma tipado); jamás concatenar input ni identificadores sin allowlist.
7. La app nunca se conecta con privilegios administrativos/owner en producción.
8. Todo `UPDATE`/`DELETE` manual lleva `WHERE` verificado antes con `SELECT`; todo cambio de esquema va por migración versionada y confirmada.

## 1. Modelado, normalización y NULL

- **Proceso:** dominio → modelo conceptual (entidades, cardinalidad, opcionalidad, ciclo de vida) → lógico (tablas, `PK`, `FK`) → `CHECK`/`UNIQUE` → normalización **3NF** (BCNF si hay claves candidatas superpuestas) → queries reales → medición → índices. El ORM se adapta al modelo, nunca al revés.
- **Relaciones:**
  - `1:1`: `PK` del hijo = `FK` al padre (o `FK + UNIQUE`). No partir tablas "por rendimiento" sin medir.
  - `1:N`: `FK` en el lado `N`; `NOT NULL` si es obligatoria; indexar la `FK` para `JOIN` y borrado del padre.
  - `N:M`: tabla asociativa con `PK` compuesta `(a_id, b_id)` + índice en `b_id`. Si tiene atributos propios, es una entidad.
  - Recursiva: `parent_id` FK a la misma tabla + `CHECK (parent_id <> id)` + `WITH RECURSIVE`.
- **Identidad:** `UUID` (`gen_random_uuid()` en PG 15; evaluar `uuidv7()` en PG 18) o `BIGINT GENERATED ALWAYS AS IDENTITY` como surrogate + `UNIQUE` en la clave natural. No usar secuencias para numeración correlativa sin huecos.
- **Desnormalización:** solo documentada (snapshots históricos como `audit_logs."oldValues"`/`"newValues"`, o agregados medidos).
- **Semántica de `NULL`:** `NOT NULL` por defecto; un `NULL` debe tener un único significado por columna.
- **Nombres:** consistentes y sin palabras reservadas (`user`, `order`, `group`). En el esquema actual de Recetaria las columnas camelCase generadas para Prisma van entre comillas dobles (`"authorId"`, `"prepTimeMinutes"`, `"createdAt"`); toda constraint debe llevar nombre explícito (`pk_`, `fk_`, `uq_`, `chk_`, `idx_`).

## 2. SQL correcto, índices y concurrencia

- **Orden lógico de evaluación:** `FROM/JOIN` → `WHERE` → `GROUP BY` → `HAVING` → `SELECT` (incluye window functions) → `DISTINCT` → `ORDER BY` → `LIMIT`/`FETCH`.
- **Lógica de tres valores:** usar `IS NULL` / `IS NOT DISTINCT FROM` / `COALESCE`; evitar `NOT IN (subquery)` cuando puede haber `NULL` (preferir `NOT EXISTS`).
- **JOINs:** filtrar la tabla derecha de un `LEFT JOIN` dentro de `ON`, nunca en `WHERE`; nunca usar `DISTINCT` para tapar un fan-out.
- **Sargabilidad:** evitar funciones sobre columnas indexadas en `WHERE` (`created_at >= $1 AND created_at < $2` en rangos semiabiertos `[inicio, fin)`, nunca `EXTRACT(YEAR FROM ...)`).
- **Lecturas y paginación:** proyectar columnas explícitas (no `SELECT *`), evitar N+1 y usar **paginación keyset** (`ORDER BY "createdAt" DESC, id DESC`) en listados grandes en lugar de `OFFSET` profundo.
- **Índices:** orden compuesto **igualdad → orden → rango** (no "la más selectiva primero"). Evitar índices duplicados (en Recetaria, `UNIQUE` en `users.email` y `recipes.slug` ya crea su B-tree; evitar duplicarlo al crear nuevas tablas).
- **Concurrencia:** transacciones cortas sin I/O externo dentro; cubrir *lost update* con `UPDATE` condicional atómico, concurrencia optimista (`version`) o `FOR UPDATE`; prevenir deadlocks ordenando locks por `id` y reintentando transacciones idempotentes con backoff + jitter.

## 3. Colaboración y delegación

| Necesidad | Skill |
|---|---|
| Internals PostgreSQL (`JSONB`, `GIN`, `EXPLAIN`, MVCC/VACUUM, locks DDL, roles/RLS, PITR) | [postgresql-engineering](../postgresql-engineering/SKILL.md) |
| Capa ORM Prisma 7 (`@prisma/adapter-pg`, repositorios, pool, mapeo `P2002`/`SQLSTATE`, `TypedSQL`) | [orm-persistence-js-ts](../orm-persistence-js-ts/SKILL.md) |
| Validar, generar y aplicar migraciones Prisma (con confirmación humana) | [db-migration](../db-migration/SKILL.md) |
| Frontera `repository.ts` y transacciones `prisma.$transaction` en 4 capas | [layered-architecture-ts](../layered-architecture-ts/SKILL.md) |
| Contrato HTTP, paginación y errores JSend | [api-engineering-ts](../api-engineering-ts/SKILL.md) |
| Contenedor PostgreSQL, volúmenes y red aislada | [docker-production-containers](../docker-production-containers/SKILL.md) |

Para DDL de referencia sobre Recetaria, consultas sargables, keyset, patrones de concurrencia, *Expand → Migrate → Contract*, antipatrones y **Definition of Done**, consultá [references/sql-patterns.md](./references/sql-patterns.md).
