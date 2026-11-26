-- Remediación de cuentas privilegiadas no autorizadas (#51, runbook post-#48 —
-- docs/runbooks/post-48-deploy.md). Equivale a PATCH /api/v1/users/:id/role y /status (#53, #56)
-- con las MISMAS garantías: lock en orden fijo, revalidación del operador, nunca deja el sistema
-- sin ADMIN activo y audita con las acciones canónicas (`ROLE_CHANGED` { role } y
-- `ACCOUNT_DEACTIVATED` { isActive }, entityName = 'User', userId = operador).
--
-- SIMULACIÓN POR DEFECTO: muestra el antes/después y los registros de auditoría y termina en
-- ROLLBACK. Solo con `-v apply=1` hace COMMIT.
--
-- Variables (psql -v):
--   emails          (obligatoria) lista separada por comas de las cuentas a remediar
--   mode            (obligatoria) demote | deactivate | both
--   operator_email  (obligatoria) ADMIN activo que ejecuta (queda como autor en audit_logs)
--   apply           (opcional)    1 = aplicar (COMMIT); cualquier otro valor o ausente = simulación
--
-- Uso (1º simulación, 2º el mismo comando con -v apply=1):
--   docker compose exec -T postgres sh -c 'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -v emails="<email-1>,<email-2>" -v mode=demote -v operator_email="<admin-email>"' \
--     < scripts/ops/demote-privileged-users.sql

\set ON_ERROR_STOP 1
\pset pager off
\pset footer off

\if :{?emails}
\else
  -- RAISE (no \quit): con ON_ERROR_STOP psql sale con código ≠ 0 y una automatización lo detecta
  DO $$ BEGIN RAISE EXCEPTION 'ABORTADO: falta -v emails="<email-1>,<email-2>" (lista de cuentas a remediar). No se cambió nada.'; END $$;
\endif
\if :{?mode}
\else
  -- RAISE (no \quit): con ON_ERROR_STOP psql sale con código ≠ 0 y una automatización lo detecta
  DO $$ BEGIN RAISE EXCEPTION 'ABORTADO: falta -v mode=demote|deactivate|both. No se cambió nada.'; END $$;
\endif
\if :{?operator_email}
\else
  -- RAISE (no \quit): con ON_ERROR_STOP psql sale con código ≠ 0 y una automatización lo detecta
  DO $$ BEGIN RAISE EXCEPTION 'ABORTADO: falta -v operator_email="<admin-email>" (ADMIN activo que ejecuta). No se cambió nada.'; END $$;
\endif
\if :{?apply}
\else
  \set apply 0
\endif
SELECT (:'apply' = '1') AS do_apply \gset

BEGIN;

SELECT
  set_config('recetaria_ops.emails', :'emails', true),
  set_config('recetaria_ops.mode', :'mode', true),
  set_config('recetaria_ops.operator', :'operator_email', true)
\gset ignored_

CREATE TEMP TABLE ops_changes (
  email text NOT NULL,
  accion text NOT NULL,
  antes jsonb NOT NULL,
  despues jsonb NOT NULL
) ON COMMIT DROP;

DO $$
DECLARE
  v_mode text := current_setting('recetaria_ops.mode');
  v_operator_email text := lower(btrim(current_setting('recetaria_ops.operator')));
  v_emails text[];
  v_operator_id uuid;
  v_missing text[];
  v_not_privileged text[];
  v_target record;
  v_active_admins uuid[];
BEGIN
  -- Guardas (fail closed): cualquier violación aborta la transacción sin cambios
  SELECT coalesce(array_agg(DISTINCT e ORDER BY e), '{}')
    INTO v_emails
    FROM unnest(string_to_array(current_setting('recetaria_ops.emails'), ',')) AS raw(value),
         lower(btrim(raw.value)) AS e
   WHERE e <> '';
  IF cardinality(v_emails) = 0 THEN
    RAISE EXCEPTION 'ABORTADO: la lista de emails está vacía. No se cambió nada.';
  END IF;
  IF v_mode NOT IN ('demote', 'deactivate', 'both') THEN
    RAISE EXCEPTION 'ABORTADO: mode inválido "%" (usar demote, deactivate o both). No se cambió nada.', v_mode;
  END IF;
  IF v_operator_email = ANY (v_emails) THEN
    RAISE EXCEPTION 'ABORTADO: el operador % no puede remediarse a sí mismo. No se cambió nada.', v_operator_email;
  END IF;

  -- Orden fijo de bloqueo, igual que la API (users.repository.ts): 1) ADMIN activos, 2) destinos
  SELECT coalesce(array_agg(id ORDER BY id), '{}') INTO v_active_admins
    FROM (SELECT id FROM users WHERE role = 'ADMIN' AND "isActive" ORDER BY id FOR NO KEY UPDATE) AS locked;
  SELECT id INTO v_operator_id FROM users WHERE email = v_operator_email;
  IF v_operator_id IS NULL OR NOT (v_operator_id = ANY (v_active_admins)) THEN
    RAISE EXCEPTION 'ABORTADO: el operador % no es un ADMIN activo. No se cambió nada.', v_operator_email;
  END IF;

  PERFORM 1 FROM users WHERE email = ANY (v_emails) ORDER BY id FOR NO KEY UPDATE;
  SELECT coalesce(array_agg(e ORDER BY e), '{}') INTO v_missing
    FROM unnest(v_emails) AS e WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.email = e);
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'ABORTADO: emails inexistentes: %. No se cambió nada.', array_to_string(v_missing, ', ');
  END IF;
  SELECT coalesce(array_agg(email ORDER BY email), '{}') INTO v_not_privileged
    FROM users WHERE email = ANY (v_emails) AND role = 'USER';
  IF cardinality(v_not_privileged) > 0 THEN
    RAISE EXCEPTION 'ABORTADO: no son cuentas privilegiadas (ya son USER): %. No se cambió nada.',
      array_to_string(v_not_privileged, ', ');
  END IF;

  -- Invariante: nunca dejar el sistema sin ADMIN activo (el operador no está en la lista)
  IF NOT EXISTS (
    SELECT 1 FROM unnest(v_active_admins) AS admin_id
     WHERE admin_id NOT IN (SELECT id FROM users WHERE email = ANY (v_emails))
  ) THEN
    RAISE EXCEPTION 'ABORTADO: el cambio dejaría el sistema sin ADMIN activo. No se cambió nada.';
  END IF;

  -- Remediación + auditoría canónica (mismo formato que la API); los no-ops no se auditan
  FOR v_target IN SELECT id, email, role::text AS role, "isActive" FROM users WHERE email = ANY (v_emails) ORDER BY id LOOP
    IF v_mode IN ('demote', 'both') THEN
      UPDATE users SET role = 'USER' WHERE id = v_target.id;
      INSERT INTO audit_logs ("entityName", "entityId", action, "userId", "oldValues", "newValues")
      VALUES ('User', v_target.id, 'ROLE_CHANGED', v_operator_id,
              jsonb_build_object('role', v_target.role), jsonb_build_object('role', 'USER'));
      INSERT INTO ops_changes VALUES (v_target.email, 'ROLE_CHANGED',
              jsonb_build_object('role', v_target.role), jsonb_build_object('role', 'USER'));
    END IF;
    IF v_mode IN ('deactivate', 'both') AND v_target."isActive" THEN
      UPDATE users SET "isActive" = false WHERE id = v_target.id;
      INSERT INTO audit_logs ("entityName", "entityId", action, "userId", "oldValues", "newValues")
      VALUES ('User', v_target.id, 'ACCOUNT_DEACTIVATED', v_operator_id,
              jsonb_build_object('isActive', true), jsonb_build_object('isActive', false));
      INSERT INTO ops_changes VALUES (v_target.email, 'ACCOUNT_DEACTIVATED',
              jsonb_build_object('isActive', true), jsonb_build_object('isActive', false));
    END IF;
  END LOOP;
END
$$;

\echo '== Cambios (antes → después) =='
SELECT email, accion, antes, despues FROM ops_changes ORDER BY email, accion;

\echo '== Estado resultante de las cuentas =='
SELECT u.email, u.role, u."isActive" AS activo
FROM users u
WHERE u.email = ANY (
  SELECT lower(btrim(value)) FROM unnest(string_to_array(current_setting('recetaria_ops.emails'), ',')) AS value
)
ORDER BY u.email;

\if :do_apply
  COMMIT;
  \echo 'APLICADO: cambios confirmados (COMMIT) con su registro en audit_logs.'
\else
  ROLLBACK;
  \echo 'SIMULACIÓN: no se aplicó nada (ROLLBACK). Revisá la vista previa y repetí con -v apply=1.'
\endif
