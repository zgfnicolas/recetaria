# Runbook — Despliegue posterior a #48: auditar cuentas privilegiadas y rotar `JWT_SECRET`

Ticket: #51 · Contexto: [ADR-0007](../adr/0007-registro-publico-sin-asignacion-de-rol.md), `docs/sad.md` §7 · Ejecuta: **una persona** con acceso al entorno y a su gestor de secretos (`AGENTS.md` → Límites).

## Por qué
#48 cerró la auto-asignación de roles en `POST /api/v1/auth/register`, pero el cambio de código **no corrige el estado heredado** de un entorno que estuvo expuesto antes del despliegue:

- **Cuentas privilegiadas auto-registradas:** las filas de `users` creadas con `role` `ADMIN`, `CHEF` o `NUTRITIONIST` desde `/register` conservan ese rol.
- **JWT ya emitidos:** los tokens de esas cuentas, o los filtrados de cuentas legítimas durante la ventana expuesta, siguen firmados con el secreto vigente.

Desde que se escribió el ticket el sistema cambió, y eso reduce el riesgo pero no lo elimina:

- **ADR-0009 (#56):** la API autoriza con el rol y el estado **vigentes** en la base. Remediar una cuenta (paso 2) le corta el acceso privilegiado **de inmediato**, aunque su JWT siga firmado.
- **#52:** `JWT_EXPIRES_IN` tiene un tope de `1d`, así que un token viejo vive como máximo un día.
- **Rotar el secreto (paso 3) sigue siendo recomendable:** invalida **todo** token emitido antes, incluidos los de cuentas legítimas que pudieron filtrarse, y deja un corte limpio y verificable.

## Precondiciones
1. **Backup** de la base antes de tocar datos. Va **fuera del repositorio** y con permisos restringidos, porque contiene hashes y emails. Se borra o se guarda cifrado al terminar:
   ```bash
   umask 077 && mkdir -p ~/recetaria-backups
   docker compose -f compose.yaml exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > ~/recetaria-backups/backup-<AAAAMMDD>.dump
   ```
2. **Ventana de mantenimiento anunciada:** el paso 3 cierra la sesión de **todos** los usuarios.
3. **Un token de referencia de una cuenta legítima**, por ejemplo el del operador. Se obtiene **antes** del paso 3 con un login, para comprobar después la rotación. No sirve el token de una cuenta remediada: esa recibe `401`/`403` aunque no se rote nada, por ADR-0009.
4. **Un operador `ADMIN` activo y legítimo** (`<admin-email>`), que queda como autor de la remediación en `audit_logs` y no puede estar entre las cuentas a remediar.
   - En un entorno **expuesto**, **no** uses una cuenta del seed: su contraseña (`password123`) es pública en el repositorio. Usá un `ADMIN` otorgado y auditado.
   - Si el único `ADMIN` legítimo es el del seed, primero creá el `ADMIN` operador por la vía de alta controlada (`docs/sad.md` §7: SQL manual del primer `ADMIN`).
5. **Acceso a `psql`** contra la base del entorno. Los ejemplos usan el contenedor `postgres` de Compose; con otro acceso, cambiá `docker compose … exec -T postgres sh -c 'psql …'` por tu cliente `psql -X`.

## Orden: auditar → remediar → rotar → verificar

### Paso 1 — Auditar (solo lectura)
```bash
docker compose -f compose.yaml exec -T postgres sh -c 'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < scripts/ops/audit-privileged-users.sql
```
Lista toda cuenta con `role <> 'USER'` y su **origen**:

| Origen | Significado | Acción |
|---|---|---|
| `seed` | Uno de los 4 usuarios de `prisma/seed.ts`, con su rol de seed | Solo en desarrollo o test. En un entorno **expuesto**, **desactivarlas** en el paso 2 (`mode=deactivate`), porque su contraseña es pública |
| `otorgado por ADMIN` | Su rol coincide con el último `ROLE_CHANGED` (asignado por la API, #53) y quien lo otorgó (`otorgado_por`) es confiable: el `ADMIN` del seed o un `ADMIN` auditado | Mantener, si el otorgamiento es legítimo |
| **`otorgado por cuenta SIN RASTRO`** | Hay `ROLE_CHANGED`, pero lo otorgó una cuenta sin rastro, por ejemplo un intruso que usó `/role` antes de ser remediado | **Revisar** y, si no es legítima, remediar en el paso 2 |
| **`SIN RASTRO`** | Rol privilegiado sin seed ni auditoría: típico de un auto-registro anterior a #48 | **Remediar** en el paso 2, salvo que se confirme que es legítima |

El script corre dentro de `BEGIN TRANSACTION READ ONLY … ROLLBACK`: no puede escribir, aunque se lo edite por error.

### Paso 2 — Remediar (simulación primero, después aplicar)
Primero se arma la lista de emails a remediar, solo los confirmados como no autorizados, y se elige el modo:
- `demote`: pasa a `USER` y registra `ROLE_CHANGED`;
- `deactivate`: pone `isActive = false` y registra `ACCOUNT_DEACTIVATED`;
- `both`: hace las dos cosas.

**2.a. Simulación**, el comportamiento por defecto. Muestra el antes y el después y termina en `ROLLBACK`:
```bash
docker compose -f compose.yaml exec -T postgres sh -c 'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v emails="<email-1>,<email-2>" -v mode=demote -v operator_email="<admin-email>"' \
  < scripts/ops/demote-privileged-users.sql
```
**2.b. Aplicar.** Es el mismo comando con `-v apply=1`. Hace `COMMIT` y deja **un evento canónico por cambio** en `audit_logs` (`entityName = 'User'`, `userId` = operador), con el mismo formato que `PATCH /api/v1/users/:id/role` y `/status`.

**Notas de uso:**
- **Elegir el modo una sola vez:** si además de degradar hay que desactivar, usá `mode=both` de entrada. Una cuenta que ya es `USER` no se vuelve a aceptar (aborta con "ya son USER"); para desactivarla después, usá la API (`PATCH /status`).
- **Mayúsculas:** los emails se comparan en minúsculas, que es como los guarda la API. Una cuenta antigua guardada con mayúsculas aborta como inexistente, sin cambios. En ese caso, remediarla por API o con su email exacto en minúsculas tras revisarla.
- **Comillas y `$`:** los valores van dentro de `sh -c '…'`. Una comilla simple, un `$` o una comilla invertida en un email, todos poco habituales, rompen el comando del shell o se expanden (el SQL está protegido). En ese caso, ejecutá `psql` directamente, sin `sh -c`.

**Garantías del script** (las mismas que la API):
- **Aborta sin cambios** y con código de salida distinto de 0 si:
  - falta una variable o la lista está vacía;
  - el modo es inválido;
  - un email no existe o ya es `USER`;
  - el operador no es un `ADMIN` activo o está en la lista.
- **Bloquea las filas** en orden fijo: primero los `ADMIN` activos, después los destinos.
- **Nunca deja el sistema sin `ADMIN` activo.**
- **No audita lo que no cambia:** por ejemplo, una cuenta que ya estaba inactiva.

**Vía alternativa por API**, cuando son pocas cuentas y hay un `ADMIN` confiable con sesión. El token se lee sin eco y viaja por stdin, así que no queda en el historial ni en `ps`:
```bash
read -rs ADMIN_TOKEN   # pegar el token del ADMIN (no se muestra)
curl -X PATCH <base-url>/api/v1/users/<user-id>/role   -H @- -H "Content-Type: application/json" -d '{"role":"USER"}'     <<< "Authorization: Bearer $ADMIN_TOKEN"
curl -X PATCH <base-url>/api/v1/users/<user-id>/status -H @- -H "Content-Type: application/json" -d '{"isActive":false}' <<< "Authorization: Bearer $ADMIN_TOKEN"
```
Por ADR-0009, cualquiera de las dos vías corta el acceso privilegiado de la cuenta **en la siguiente solicitud**.

### Paso 3 — Rotar `JWT_SECRET`
1. Generar un secreto nuevo. La API exige al menos 32 caracteres y valida la variable al arrancar:
   ```bash
   openssl rand -base64 48
   ```
2. Reemplazar `JWT_SECRET` en el **gestor de secretos** del entorno, o en su `.env` (nunca en el repositorio ni en tickets o chats).
3. Reiniciar la API para que tome el valor nuevo:
   ```bash
   docker compose -f compose.yaml up -d api
   ```
4. **Impacto:** cierre de sesión global. Todo JWT emitido antes recibe `401 Unauthorized` y los usuarios tienen que volver a iniciar sesión.

### Paso 4 — Verificar
1. **Auditoría limpia:** se repite el paso 1. No queda ninguna cuenta `SIN RASTRO` activa, y las remediadas ya no figuran (`USER`) o están inactivas.
2. **Trazabilidad:** hay un evento por cambio, a nombre del operador.
   ```bash
   docker compose -f compose.yaml exec -T postgres sh -c 'psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
   SELECT a."createdAt", u.email AS cuenta, a.action, op.email AS operador, a."oldValues", a."newValues"
   FROM audit_logs a
   LEFT JOIN users u ON u.id = a."entityId"
   LEFT JOIN users op ON op.id = a."userId"
   WHERE a."entityName" = 'User' AND a.action IN ('ROLE_CHANGED', 'ACCOUNT_DEACTIVATED')
   ORDER BY a."createdAt" DESC
   LIMIT 20;
   SQL
   ```
3. **Rotación efectiva:** el **token de referencia** (de una cuenta legítima, obtenido antes del paso 3) recibe `401`, y un login nuevo obtiene `200`:
   Las credenciales se leen sin eco y viajan por stdin, así que no quedan en el historial ni en `ps`:
   ```bash
   read -rs REF_TOKEN    # token de referencia, obtenido antes del paso 3
   curl -s -o /dev/null -w '%{http_code}\n' <base-url>/api/v1/recipes/mine -H @- <<< "Authorization: Bearer $REF_TOKEN"   # 401
   read -rs PASSWORD     # contraseña del operador
   printf '{"email":"%s","password":"%s"}' '<admin-email>' "$PASSWORD" \
     | curl -s -o /dev/null -w '%{http_code}\n' -X POST <base-url>/api/v1/auth/login -H "Content-Type: application/json" -d @-   # 200
   unset REF_TOKEN PASSWORD ADMIN_TOKEN
   ```

## Reversión
- **Una cuenta remediada por error:** se le devuelve el rol o se la reactiva **por API**, con un `ADMIN` (`PATCH /role`, `PATCH /status`). Queda auditado y no hace falta tocar SQL.
- **Un error masivo:** se restaura el backup de las precondiciones en una ventana de mantenimiento, con la API detenida. **Atención:** restaurar también **revierte `audit_logs`** al momento del backup, así que se pierden los eventos posteriores, incluida la remediación. Antes de restaurar, exportá esos eventos (la consulta del paso 4.2) y documentá la reversión fuera de la base.
  ```bash
  docker compose -f compose.yaml stop api
  docker compose -f compose.yaml exec -T postgres sh -c 'pg_restore --clean --if-exists -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < ~/recetaria-backups/backup-<AAAAMMDD>.dump
  docker compose -f compose.yaml start api
  ```
- **El secreto:** no se "des-rota". Si el nuevo se filtra, se rota otra vez.

## Verificación automatizada
- **Scripts:** `tests/ops/privileged-users-scripts.test.ts` ejecuta los dos scripts **reales** con `psql` contra la base aislada de pruebas (#59). Cubre:
  - la clasificación de la auditoría y su condición de solo lectura;
  - cada guarda de la remediación;
  - la simulación y la aplicación;
  - que sea exactamente un evento canónico por cambio, a nombre del operador.
- **Efecto en la API:** la misma suite verifica el efecto inmediato de remediar (ADR-0009) y el `401` de un token anterior a la rotación.
- **`psql`:** si no está instalado en el host, la suite de scripts se omite y lo indica.
