# Plan — #51 [Spec 06.4] Runbook de despliegue post-#48: auditar cuentas privilegiadas y rotar `JWT_SECRET`

Fecha: 2026-11-25 · Rama propuesta: `docs/51-deploy-runbook` (desde `main`, con #61 mergeado) · Parent: `#6` · Estado: **Completado y archivado (2026-11-25)** · Etiqueta: `ready-for-human`

## 1. Objetivo
Entregar un runbook reproducible para la primera puesta en marcha posterior a #48 en un entorno **con datos**, que corrija el estado heredado que el cambio de código no toca: cuentas privilegiadas auto-registradas y JWT ya emitidos. El runbook tiene cuatro pasos:
1. **Auditar**, con un script de solo lectura.
2. **Remediar**, con un script transaccional, explícito y auditado.
3. **Rotar `JWT_SECRET`**, con un procedimiento documentado.
4. **Verificar.**

**División de responsabilidades (por qué es `ready-for-human`):** el agente redacta los scripts y el runbook y los verifica en entornos **efímeros y locales**. La ejecución en un entorno real, que toca sus datos y su gestor de secretos, la hace una persona (`AGENTS.md` → Límites).

## 2. Estado actual (análisis)
El ticket se escribió **antes** de #52, #53 y #56. Varias premisas cambiaron:

| Premisa del ticket | Hoy | Consecuencia para el runbook |
|---|---|---|
| "`authMiddleware` es 100 % stateless": un token privilegiado sirve hasta `JWT_EXPIRES_IN` | **ADR-0009 (#56):** `authMiddleware` resuelve el rol y el estado **vigentes** en la base en cada solicitud | Degradar o desactivar una cuenta corta su acceso **de inmediato**, sin rotar el secreto. La rotación sigue recomendada: invalida **todo** token emitido antes, incluidos los robados o filtrados de cuentas legítimas, y cierra cualquier duda sobre lo emitido durante la ventana expuesta |
| "`JWT_EXPIRES_IN` admite hasta `999999y`" | **#52:** tope de `1d`, validado al arrancar, al firmar y al verificar. Además, desde #22, se rechaza un `iat` futuro | La exposición residual de un token viejo es de 1 día como máximo |
| Remediar con SQL manual, sin control de acceso | **#53 y #56:** `PATCH /users/:id/role` y `/status` están auditados (`ROLE_CHANGED`, `ACCOUNT_DEACTIVATED`), con revalidación del actor, lock y protección del último `ADMIN` | Ya hay dos vías. La API, si hay un `ADMIN` confiable. El SQL, para remediar en bloque o si no se puede confiar en ningún `ADMIN` en línea. El SQL debe ofrecer **las mismas garantías** que la API |
| Acciones de auditoría `ROLE_REVOKED`/`DEACTIVATED` | Las acciones canónicas son `ROLE_CHANGED` (`{ role }`) y `ACCOUNT_DEACTIVATED` (`{ isActive }`), con `entityName = 'User'` (ADR-0008) | Conviene reusar las canónicas, para que una consulta del historial por acción encuentre todo (pregunta 2) |

**Recursos disponibles:**
- `psql` existe en el host (v18) y en el contenedor `postgres` (v15).
- El estilo de script de referencia es `scripts/perf/explain-recipes-list.sql`: psql con `\set ON_ERROR_STOP`, guardas `\if` y `BEGIN … ROLLBACK`.
- Los 4 emails del seed están en `prisma/seed.ts` (`SEED_USERS`).
- La base `recetaria_test` está aislada (#59), así que los scripts se pueden probar ahí sin tocar desarrollo.

## 3. Diseño propuesto
### 3.1 `scripts/ops/audit-privileged-users.sql` — solo lectura
- Usa `BEGIN TRANSACTION READ ONLY … ROLLBACK`: aunque alguien lo edite, la base rechaza cualquier escritura.
- Lista `id`, `email`, `role`, `isActive`, `createdAt` y una columna **`origen`**:
  - `seed`: uno de los 4 emails de `prisma/seed.ts`;
  - `otorgado por ADMIN`: hay un `ROLE_CHANGED` hacia ese rol en `audit_logs`;
  - **`SIN RASTRO`**: rol privilegiado sin seed ni auditoría, que es el candidato a remediar.
- Ordena por `origen` y `createdAt`, y al final muestra un resumen por origen.
- Sin variables obligatorias. Uso:

  ```bash
  docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < scripts/ops/audit-privileged-users.sql
  ```

### 3.2 `scripts/ops/demote-privileged-users.sql` — remediación explícita, auditada y segura por defecto
- **Variables `psql`:**
  - `-v emails='a@x.com,b@y.com'` (obligatoria);
  - `-v mode=demote|deactivate|both` (obligatoria, sin valor por defecto);
  - `-v operator_email=…` (el `ADMIN` activo que ejecuta, para la atribución);
  - `-v apply=1` (opcional).
- **Guardas *fail closed*:** abortan **antes** de abrir la transacción, sin cambios, si:
  - falta `emails` o la lista está vacía;
  - el `mode` es inválido;
  - un email no existe o ya es `USER` (con `mode=demote`);
  - el `operator_email` no es un `ADMIN` activo, o está en la propia lista;
  - el cambio dejaría el sistema **sin `ADMIN` activo**.
- **En una sola transacción** se bloquean las filas (`FOR NO KEY UPDATE`, el mismo orden de locks que la API) y para cada email:
  - `demote`: `role = 'USER'` y `ROLE_CHANGED` con `{ role: <anterior> }` → `{ role: 'USER' }`;
  - `deactivate`: `isActive = false` y `ACCOUNT_DEACTIVATED` con `{ isActive: true }` → `{ isActive: false }`.

  Siempre con `entityName = 'User'` y `userId` del operador: **el mismo formato que la API**, así que el historial queda uniforme.
- **Vista previa antes de confirmar:** muestra el antes y el después de cada cuenta y las filas de `audit_logs` que se insertarían.
  - Sin `-v apply=1` termina en `ROLLBACK`: es una **simulación** por defecto, que no cambia nada.
  - Con `apply=1` hace `COMMIT`.

### 3.3 Rotación de `JWT_SECRET` — procedimiento documentado (lo ejecuta una persona)
1. Generar el secreto: `openssl rand -base64 48` (≥ 32 caracteres; lo valida `src/config/env.ts`).
2. Reemplazarlo en el gestor de secretos o en el `.env` del entorno, **sin** commitearlo.
3. Reiniciar la API (`docker compose -f compose.yaml up -d api`).
4. **Impacto:** cierre de sesión global. Todo JWT emitido antes recibe `401` y hay que volver a iniciar sesión. Conviene anunciarlo antes.
5. **Por qué rotar si ADR-0009 ya corta a los degradados:** invalida tokens filtrados de cuentas **legítimas** que hayan quedado expuestas en la ventana previa a #48 y deja un corte limpio.

### 3.4 Verificación (paso 4 del runbook)
- **Auditoría:** se vuelve a correr y **no queda ninguna cuenta `SIN RASTRO`**. Las remediadas aparecen como `USER` o inactivas.
- **Historial:** `audit_logs` muestra un `ROLE_CHANGED` o `ACCOUNT_DEACTIVATED` por cuenta, con el operador como autor.
- **Rotación:** un token emitido **antes** de rotar recibe `401` en `GET /api/v1/recipes/mine`, y un login nuevo funciona. El runbook incluye los `curl` de comprobación, con marcadores en lugar de datos reales.

### 3.5 Documentación — `docs/runbooks/post-48-deploy.md`
- **Contenido:**
  - precondiciones (backup previo, ventana de mantenimiento);
  - los 4 pasos en orden, con los comandos completos usando marcadores (`<admin-email>`, `<base-url>`);
  - criterios de verificación;
  - cómo revertir: restaurar el backup, o con la API, que vuelve a otorgar el rol con auditoría;
  - la vía alternativa por API (`/role`, `/status`) cuando hay un `ADMIN` confiable.
- **Enlaces:** desde `README.md`, `docs/sad.md` §7 (el riesgo de #21 remite al runbook) y `CHANGELOG.md`.
- **Higiene:** sin secretos reales ni datos personales.

### 3.6 Verificación automatizada y local
- **`tests/ops/privileged-users-scripts.test.ts`:** ejecuta los scripts **reales** con `psql` contra la base aislada `recetaria_test`, con los datos sembrados por la prueba. Usa el `psql` del **host**; si no está instalado, la suite de scripts se omite con un motivo claro (`describe.skipIf`). La compatibilidad con el `psql` 15 del contenedor queda cubierta por el ensayo de punta a punta, que ejecuta los scripts por `docker compose exec`. Cubre:
  - la auditoría detecta un `ADMIN` "auto-registrado" (`SIN RASTRO`) y distingue los del seed;
  - una lista vacía, un modo inválido, un email inexistente, un operador no `ADMIN` y el caso que dejaría sin `ADMIN` **abortan sin cambios**;
  - la simulación no cambia nada;
  - `apply=1` cambia **solo** los emails listados y registra exactamente un evento de auditoría canónico por cuenta, con el operador.
- **Rotación:** una prueba de integración comprueba que un token firmado con el secreto **viejo** recibe `401` en una app con el secreto **nuevo**, y que un login nuevo obtiene `200`.
- **Verificación manual local del ticket** (último criterio), en un **proyecto Compose efímero** como el humo de #24, sin tocar la base de desarrollo:
  1. se crea un `ADMIN` sin rastro;
  2. auditar, remediar, rotar y verificar, siguiendo el runbook al pie de la letra;
  3. la evidencia queda en el PR.

## 4. Fases
### Fase 1 — Triage y rama · Estado: Hecha
- [x] §6 resuelto: preguntas 1–4 con las opciones recomendadas. La pregunta 5, si hay un entorno real expuesto, se confirma con el humano antes de cerrar el ticket.
- [x] Rama `docs/51-deploy-runbook` creada desde `main`.

### Fase 2 — Scripts SQL (§3.1, §3.2) · Estado: Hecha

### Fase 3 — Pruebas automatizadas (§3.6) · Estado: Hecha
- [x] Mutaciones:
  - sin la guarda de lista vacía → falla 1;
  - `COMMIT` sin `apply` → falla la de simulación;
  - operador sin revalidar como `ADMIN` activo → fallan 2.
- [x] La guarda del **último `ADMIN`** es inalcanzable desde el script, porque el operador tiene que ser un `ADMIN` activo fuera de la lista. Queda como invariante defensiva, igual que el `409` de la API, y por eso no tiene mutación.

### Fase 4 — Runbook y documentación (§3.3–§3.5) · Estado: Hecha

### Fase 5 — Verificación local de punta a punta, auditorías y cierre · Estado: Hecha
Resultado:
- `typecheck`, `typecheck:test` y `build` OK; `npm test` da 62 archivos · 1511 pruebas, con 25 en la suite de operación. El ensayo se **repitió** con la versión final: 13/13 sin restos.
- **Ensayo del runbook al pie de la letra**, en un proyecto Compose efímero (`recetaria-runbook`) con la imagen de producción, **sin restos**:
  1. Se simula el estado heredado: un `ADMIN` `SIN RASTRO` con JWT vigente, que administra roles (200).
  2. Paso 1: la auditoría lo marca `SIN RASTRO`.
  3. Paso 2.a: la simulación no cambia nada.
  4. Paso 2.b: aplicar lo degrada. Su JWT vigente ya da **403** antes de rotar (ADR-0009).
  5. Paso 3: la API reinicia con el secreto rotado.
  6. Paso 4:
     - la auditoría ya no tiene cuentas `SIN RASTRO`;
     - `audit_logs` muestra `ROLE_CHANGED ADMIN→USER por admin@recetaria.com`;
     - el token anterior da **401**;
     - un login nuevo da 200.

**Decisiones de implementación:**
- Las guardas de variables faltantes usan `RAISE EXCEPTION` y no `\quit`, que sale con código 0 y engañaría a una automatización.
- La auditoría no crea ni vistas temporales: una transacción `READ ONLY` no admite DDL. La consulta se define inline.
- [ ] Ensayo del runbook en un proyecto Compose efímero.
- [ ] `npm run typecheck`, `build` y `test`.
- [ ] Auditorías `security-auditor` y `qa-tester`. Se archiva el plan.
- [ ] La ejecución en un entorno real queda a cargo de una persona: el ticket conserva `ready-for-human` para ese paso, o se cierra si no hay ningún entorno expuesto (pregunta 5).

## 5. Riesgos
- **Remediar una cuenta legítima por error:** se mitiga con la simulación por defecto, la lista explícita, la vista previa antes del `COMMIT`, el backup previo y la reversión documentada.
- **Quedarse sin `ADMIN`:** guarda dura en el script, más el requisito de un operador `ADMIN` activo que no esté en la lista.
- **Rotar sin avisar:** el cierre de sesión global es intencional, pero tiene que anunciarse antes. El runbook lo exige como precondición.
- **Versiones de `psql`:** los scripts usan `\if` y variables `-v` (psql ≥ 10). Las pruebas automatizadas usan el `psql` del host (v18 en el equipo de desarrollo), y el ensayo de punta a punta cubrió el `psql` 15 del contenedor.

## 6. Preguntas abiertas
1. **Alcance actualizado:** ¿adapto el runbook a la realidad posterior a #52, #53 y #56? Es decir: tope de 1 día, ADR-0009 (remediar corta el acceso de inmediato) y la vía alternativa por API. Se mantiene el orden del ticket: auditar → remediar → rotar → verificar. *Recomendado: sí. Un runbook que describe un sistema stateless que ya no existe induciría a error.*
2. **Acciones de auditoría:** ¿uso las canónicas `ROLE_CHANGED` y `ACCOUNT_DEACTIVATED`, con el mismo formato que la API, o las nuevas `ROLE_REVOKED`/`DEACTIVATED` que propone el ticket? *Recomendado: las canónicas. El historial queda uniforme y consultable por acción, y no se inventan acciones que ningún otro componente usa.*
3. **Atribución:** ¿exijo `-v operator_email=` de un `ADMIN` activo, que queda como `userId` de cada registro, o dejo `userId = NULL`? *Recomendado: exigirlo. Así la auditoría tiene un responsable, igual que en la API (no repudio).*
4. **Seguridad de ejecución:** ¿simulación por defecto, con `-v apply=1` para confirmar, o aplicar directo? *Recomendado: simulación por defecto. Es la práctica estándar en scripts de remediación de datos y cumple "se muestra el resultado antes del `COMMIT`".*
5. **Cierre del ticket:** cuando se mergee el runbook verificado, ¿cierro el #51, o lo dejo abierto con `ready-for-human` hasta que alguien lo ejecute en un entorno real? *Recomendado: cerrarlo si hoy no hay ningún entorno con datos expuesto antes de #48. El entregable del ticket es el runbook; ejecutarlo es una tarea operativa. Si hay un entorno real, dejarlo abierto hasta ejecutarlo.* ¿Existe hoy algún entorno desplegado con datos (staging, demo)?

## Auditorías (2 subagentes en paralelo, solo lectura: sin Docker, sin `psql` y sin tests)
- **security-auditor:** **sin VETO**, sin hallazgos críticos ni altos. No hay inyección: las variables entran como literales escapados y pasan por `set_config`. No hay forma de aplicar por accidente: `apply` tiene que valer exactamente `'1'`, y con `ON_ERROR_STOP` más el `DO` atómico, un error no deja cambios a medias. Tampoco hay escalada: los modos solo bajan privilegios. El orden de locks es el mismo que en la API.
  - Media → **resuelta**: la auditoría muestra `otorgado_por` y distingue `otorgado por cuenta SIN RASTRO`, para que los cómplices de un intruso no pasen por legítimos. Tiene prueba.
  - Media → **resuelta**: el backup va fuera del repositorio con `umask 077` y se borra o se cifra al terminar, y `*.dump` está en `.gitignore`.
  - Media → **resuelta**: en un entorno expuesto se exige desactivar las cuentas del seed (contraseña pública) y usar un operador que no sea del seed.
  - Bajas → **resueltas**:
    - credenciales por `read -s` y stdin (`-H @-`, `-d @-`), sin pasar por el historial ni por `ps`;
    - `pg_restore` con la API detenida y la advertencia de que revierte `audit_logs`;
    - nota sobre `$` y comillas en `sh -c`.
- **qa-tester:** **cumple**, con los 6 criterios de aceptación; el desvío a las acciones canónicas está justificado (ADR-0008).
  - Medias → **resueltas**:
    - el plan aclara que la prueba usa solo el `psql` del host y que la v15 la cubre el ensayo;
    - la verificación de la rotación usa el token de referencia de una cuenta **legítima** obtenido antes del paso 3, para evitar el falso positivo por ADR-0009;
    - casos nuevos: solo `deactivate`, `deactivate` sobre una cuenta ya inactiva (0, sin cambios ni auditoría), una lista mixta (aborta todo) y duplicados (un solo evento).
  - Bajas → **resueltas**:
    - notas sobre `both`, las mayúsculas y las comillas;
    - `PGOPTIONS=-c lc_messages=C`, para no depender del idioma del servidor;
    - la aserción de código de salida que faltaba;
    - el comando `psql` de la consulta de trazabilidad;
    - `pg_restore` vía el contenedor.

## Cierre
- **Pregunta 5, resuelta por el humano (2026-11-25):** no existe ni existirá ningún entorno desplegado con datos. No hay estado heredado que remediar en un entorno real. El entregable del ticket es el runbook verificado, así que el PR usa `Closes #51` y, con #22, #23 y #24 completos, se cierra el Spec 06 (#6).
