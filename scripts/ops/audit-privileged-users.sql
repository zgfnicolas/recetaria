-- Auditoría de cuentas privilegiadas (#51, runbook post-#48 — docs/runbooks/post-48-deploy.md).
-- SOLO LECTURA: corre dentro de `BEGIN TRANSACTION READ ONLY … ROLLBACK`, sin DDL (ni vistas
-- temporales); PostgreSQL rechaza cualquier escritura aunque el script se edite por error.
--
-- Uso (contra la base del entorno; ejemplo con el contenedor de Compose):
--   docker compose exec -T postgres sh -c 'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--     < scripts/ops/audit-privileged-users.sql
--
-- Lista toda cuenta con `role <> 'USER'` y clasifica su ORIGEN:
--   - `seed`               → uno de los 4 usuarios de prisma/seed.ts, con el rol que el seed le asigna.
--   - `otorgado por ADMIN` → su rol actual coincide con el último `ROLE_CHANGED` en audit_logs
--                            (PATCH /api/v1/users/:id/role, #53) y quien lo otorgó es confiable:
--                            el ADMIN del seed o un ADMIN cuyo propio rol también está auditado.
--   - `otorgado por cuenta SIN RASTRO` → hay ROLE_CHANGED, pero lo otorgó una cuenta sin rastro
--                            (p. ej. un intruso que usó /role antes de ser remediado): REVISAR.
--   La columna `otorgado_por` muestra el email de quien otorgó el rol.
--   - `SIN RASTRO`         → rol privilegiado sin seed ni auditoría: típico de un auto-registro con
--                            `role` antes de #48. Son las candidatas a remediar
--                            (scripts/ops/demote-privileged-users.sql).

\set ON_ERROR_STOP 1
\pset pager off
\pset footer off

BEGIN TRANSACTION READ ONLY;

\echo '== Cuentas privilegiadas (role <> USER) =='
WITH privileged_accounts AS (
  WITH seed (email, role) AS (
    -- Debe coincidir con SEED_USERS (prisma/seed.ts); lo verifica tests/ops/privileged-users-scripts.test.ts
    VALUES
      ('user@recetaria.com', 'USER'),
      ('chef@recetaria.com', 'CHEF'),
      ('nutri@recetaria.com', 'NUTRITIONIST'),
      ('admin@recetaria.com', 'ADMIN')
  ),
  last_grant AS (
    SELECT DISTINCT ON ("entityId") "entityId", "newValues" ->> 'role' AS role, "userId" AS grantor_id
    FROM audit_logs
    WHERE "entityName" = 'User' AND action = 'ROLE_CHANGED'
    ORDER BY "entityId", "createdAt" DESC, id DESC
  ),
  -- Otorgante confiable: el ADMIN del seed o un ADMIN a quien a su vez se le otorgó ADMIN con auditoría
  trusted_grantor AS (
    SELECT u.id FROM users u JOIN seed s ON s.email = u.email AND s.role = 'ADMIN'
    UNION
    SELECT lg."entityId" FROM last_grant lg WHERE lg.role = 'ADMIN'
  )
  SELECT
    u.id,
    u.email,
    u.role::text AS role,
    u."isActive" AS activo,
    u."createdAt" AS creado,
    grantor.email AS otorgado_por,
    CASE
      WHEN s.email IS NOT NULL AND s.role = u.role::text THEN 'seed'
      WHEN g.role = u.role::text AND g.grantor_id IN (SELECT id FROM trusted_grantor) THEN 'otorgado por ADMIN'
      WHEN g.role = u.role::text THEN 'otorgado por cuenta SIN RASTRO'
      ELSE 'SIN RASTRO'
    END AS origen
  FROM users u
  LEFT JOIN seed s ON s.email = u.email
  LEFT JOIN last_grant g ON g."entityId" = u.id
  LEFT JOIN users grantor ON grantor.id = g.grantor_id
  WHERE u.role <> 'USER'
)
SELECT id, email, role, activo, creado, otorgado_por, origen
FROM privileged_accounts
ORDER BY CASE origen
  WHEN 'SIN RASTRO' THEN 0
  WHEN 'otorgado por cuenta SIN RASTRO' THEN 1
  WHEN 'otorgado por ADMIN' THEN 2
  ELSE 3
END, creado, id;

\echo '== Resumen por origen (remediar las SIN RASTRO activas) =='
WITH privileged_accounts AS (
  WITH seed (email, role) AS (
    -- Debe coincidir con SEED_USERS (prisma/seed.ts); lo verifica tests/ops/privileged-users-scripts.test.ts
    VALUES
      ('user@recetaria.com', 'USER'),
      ('chef@recetaria.com', 'CHEF'),
      ('nutri@recetaria.com', 'NUTRITIONIST'),
      ('admin@recetaria.com', 'ADMIN')
  ),
  last_grant AS (
    SELECT DISTINCT ON ("entityId") "entityId", "newValues" ->> 'role' AS role, "userId" AS grantor_id
    FROM audit_logs
    WHERE "entityName" = 'User' AND action = 'ROLE_CHANGED'
    ORDER BY "entityId", "createdAt" DESC, id DESC
  ),
  -- Otorgante confiable: el ADMIN del seed o un ADMIN a quien a su vez se le otorgó ADMIN con auditoría
  trusted_grantor AS (
    SELECT u.id FROM users u JOIN seed s ON s.email = u.email AND s.role = 'ADMIN'
    UNION
    SELECT lg."entityId" FROM last_grant lg WHERE lg.role = 'ADMIN'
  )
  SELECT
    u.id,
    u.email,
    u.role::text AS role,
    u."isActive" AS activo,
    u."createdAt" AS creado,
    grantor.email AS otorgado_por,
    CASE
      WHEN s.email IS NOT NULL AND s.role = u.role::text THEN 'seed'
      WHEN g.role = u.role::text AND g.grantor_id IN (SELECT id FROM trusted_grantor) THEN 'otorgado por ADMIN'
      WHEN g.role = u.role::text THEN 'otorgado por cuenta SIN RASTRO'
      ELSE 'SIN RASTRO'
    END AS origen
  FROM users u
  LEFT JOIN seed s ON s.email = u.email
  LEFT JOIN last_grant g ON g."entityId" = u.id
  LEFT JOIN users grantor ON grantor.id = g.grantor_id
  WHERE u.role <> 'USER'
)
SELECT origen, count(*) AS cuentas, count(*) FILTER (WHERE activo) AS activas
FROM privileged_accounts
GROUP BY origen
ORDER BY origen;

ROLLBACK;
