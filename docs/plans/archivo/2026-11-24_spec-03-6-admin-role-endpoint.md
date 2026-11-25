# Plan: [Spec 03.6] Endpoint de administración de roles (PATCH /api/v1/users/:id/role) restringido a ADMIN y auditado (#53)

Fecha: 2026-11-24 · Rama: `feat/53-admin-role-endpoint` · Parent: `#3` · Estado: **Completado y archivado (2026-11-24); pendiente commit/PR**

## Objetivo
Cerrar el hueco que dejó #48 (ADR-0007): hoy **no existe ningún camino en la API** para otorgar o revocar `CHEF`, `NUTRITIONIST` o `ADMIN`. Fuera de `development|test` solo queda el SQL manual, sin control de acceso de la aplicación ni registro en `audit_logs`.

Este ticket agrega `PATCH /api/v1/users/:id/role`, **exclusivo de `ADMIN`**, con el cambio de rol y el registro `ROLE_CHANGED` en la **misma** `prisma.$transaction`, y con salvaguardas para no quedarse sin moderación.

## Contexto que el agente debe leer
- `AGENTS.md`, `docs/roles.md`, `docs/business_rules.md` (`RN-06`, `RN-08`), `docs/sad.md` §6/§7, `docs/data_model.md` (`audit_logs`, `fk_audit_logs_user`), ADR-0004, ADR-0006 (fija `entityName = "Recipe"`), ADR-0007 (opción C diferida)
- Código:
  - `src/modules/auth/user.repository.ts` (`UserRecord`, `USER_PUBLIC_SELECT`)
  - `src/middlewares/rbac.middleware.ts`, `validate.middleware.ts`
  - `src/bootstrap/container.ts` (`buildApiRouters`)
  - `src/app.ts` (`DEFAULT_CORS_METHODS`, **sin `PATCH`**)
  - el patrón transaccional con `SELECT … FOR UPDATE` de `src/modules/recipes/recipe.repository.ts`
- Pruebas de referencia: `tests/support/users.ts` (`createUserWithRole`, `loginAs`), `recipes-approve.test.ts`/`recipes-delete.test.ts` (barreras de lock, trigger de *rollback*)

## Análisis del estado actual
- **No hay módulo `users`.** `auth` cubre registro y login. Administrar usuarios es otra responsabilidad, así que propongo un módulo nuevo `src/modules/users/` en 4 capas, que reutiliza los tipos `UserRole`/`USER_ROLES` de `auth`. `UserRepository` de `auth` sigue siendo el de credenciales.
- **CORS sin `PATCH`:** `DEFAULT_CORS_METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]`, así que el preflight de un navegador rechazaría `PATCH`. Hay que agregarlo.
- **Convención de auditoría:** ADR-0006 y `docs/data_model.md` fijan `entityName = "Recipe"` y las acciones `APPROVE`/`RESET_TO_DRAFT`/`DELETE`. Auditar usuarios **extiende** la convención con `entityName = "User"` y `action = "ROLE_CHANGED"`, lo que hay que documentar como decisión (pregunta 6). El esquema ya lo soporta: `entityName`/`action` son `VARCHAR(50)`, `entityId` no tiene FK y `userId` → `users` usa `SET NULL`. **No hace falta migración.**
- **Concurrencia del "último `ADMIN`":** si dos `ADMIN` se degradan mutuamente a la vez, ambos podrían ver "hay 2 `ADMIN`" y terminar con 0. La regla se decide sobre **filas bloqueadas**: dentro de la transacción, `SELECT id FROM users WHERE role = 'ADMIN' AND "isActive" FOR UPDATE`. Con `READ COMMITTED`, la segunda transacción espera, reevalúa el `WHERE` tras el commit de la primera y ya no cuenta al degradado.
- **Token del actor (stateless):** `rbacMiddleware` confía en el `role` del JWT. Un `ADMIN` recién degradado conserva su token como máximo `1d` (#52). Para **esta** operación, la más privilegiada de la API, propongo **revalidar al actor en la base** dentro de la misma transacción, como `ADMIN` activo, sin cambiar `RN-08` para el resto (pregunta 3).

## Decisiones propuestas
1. **Módulo `src/modules/users/`:**
   - `users.schema.ts`: `userIdParamsSchema` (UUID v4) y `changeRoleSchema = z.strictObject({ role: z.enum(USER_ROLES) })`, con BOPLA → `400`.
   - `users.policy.ts`: `canChangeRole(actor, targetId)`, pura (prohíbe la auto-modificación).
   - `users.service.ts`: `changeRole(actor, targetId, role)` → `404` → `403` → delega en el repositorio y traduce los resultados.
   - `users.repository.ts`: `changeRoleWithAudit({ actorId, targetId, role })` en una transacción interactiva:
     1. bloquea y revalida al **actor** (`SELECT … FOR UPDATE`): si ya no es `ADMIN` activo → `actor_not_admin` (`403`);
     2. bloquea al **destino**: si no existe → `not_found` (`404`);
     3. si el rol es igual al actual → `unchanged`: `200` sin auditoría, porque `PATCH` es idempotente (pregunta 5);
     4. si se quita `ADMIN` al destino, bloquea y cuenta los `ADMIN` activos: si quedaría ninguno → `last_admin` (`409`);
     5. `UPDATE users SET role` e inserción en `audit_logs` (`entityName: "User"`, `entityId: targetId`, `action: "ROLE_CHANGED"`, `userId: actorId`, `oldValues: { role }`, `newValues: { role }`).
   - Para evitar interbloqueos, las filas se bloquean siempre en el **mismo orden**: primero todos los `ADMIN` activos (si corresponde) y después el destino.
   - Errores: `P2003` (actor inexistente con JWT válido) → `401`.
   - `users.controller.ts` (`try/catch`, JSend `200` `{ id, email, role }` sin `passwordHash`) y `users.router.ts`: `PATCH /:id/role` con `authGuard → rbacMiddleware(["ADMIN"]) → validateMiddleware({ params, body })`.
2. **Orden de guardas** (ajustado tras la auditoría de seguridad): `401` → `403` RBAC → `400` → `403` auto-modificación → `403` actor degradado en la base → `404` → `409` último `ADMIN` → `200`.
3. **Montaje y CORS:** `{ path: "/users", router }` en `buildApiRouters` y `PATCH` en `DEFAULT_CORS_METHODS`.
4. **Documentación de decisión:** ADR-0008 "Administración de roles auditada" (implementa la opción C de ADR-0007 y extiende la convención de `audit_logs` de ADR-0006) y la regla nueva `RN-09`.
5. **Fuera de alcance:** activar o desactivar cuentas (`isActive`, endpoint aparte), listado o búsqueda de usuarios, revocación de tokens (`tokenVersion`), KYC y frontend.

## Fases

### Fase 1 — Triage, rama y registro del plan · Estado: Hecha
- [x] Resolver las preguntas abiertas (sobre todo la 1) y pasar #53 de `needs-triage` a `ready-for-agent` (o sacarlo del milestone si no entra en el MVP)
- [x] Crear la rama `feat/53-admin-role-endpoint` desde `main` (`9355b7e`, con #52 mergeado)
- [x] Mover #53 a `In Progress`
Criterio: decisiones aprobadas y rama creada.

### Fase 2 — Implementación · Estado: Hecha
- [x] Esquemas, política pura, servicio, repositorio transaccional, controlador y router del módulo `users`, con su `index.ts`
- [x] Montaje en `buildApiRouters` y `PATCH` en CORS
- [x] `npm run typecheck && npm run typecheck:test && npm run build && npm test` (0 `any`)
Criterio: compilación estricta y las 1204 pruebas existentes en verde.

### Fase 3 — Pruebas · Estado: Hecha
- [x] Unitarias:
  - `users.schema.test.ts`: UUID, roles válidos e inválidos, BOPLA (`isActive`, `email`, `id`…) y `{}`
  - `users.policy.test.ts`: auto-modificación
  - `users.service.test.ts` (mock solo del repositorio): cada resultado → código
  - `users.controller.test.ts`: JSend, *fail closed* sin `req.user` o `req.valid`
- [x] `tests/integration/http/users-role.test.ts` (Supertest + PostgreSQL 15):
  - `200`: un `ADMIN` promueve a `CHEF`, `NUTRITIONIST` y `ADMIN`, y degrada a `USER`; queda **1** `ROLE_CHANGED` con `oldValues`/`newValues`/`userId` exactos, y la respuesta no trae `passwordHash`
  - `200` idempotente con el mismo rol, sin auditoría
  - **Efecto real:** tras el cambio, un nuevo login emite un JWT con el rol nuevo y habilita o deshabilita las rutas correspondientes (p. ej. el `CHEF` promovido puede aprobar). El token anterior conserva su rol hasta vencer (comportamiento documentado y probado).
  - `400` (`:id` inválido, rol inválido, campos extra), `401` (sin token, inválido o expirado; también antes de validar), `403` (`USER`/`CHEF`/`NUTRITIONIST`; auto-modificación de un `ADMIN`; `ADMIN` con JWT vigente pero ya degradado o desactivado en la base) y `404`
  - `409`: degradar al **único** `ADMIN` activo (no se puede autodegradar, así que el caso se arma con un segundo `ADMIN` inactivo)
  - `401` para un actor con JWT válido que ya no existe (`P2003`), sin escritura parcial
  - **Carrera determinista** (barrera `FOR UPDATE` + `pg_stat_activity`): con dos `ADMIN` activos que se degradan mutuamente a la vez, uno responde `200` y el otro `403`/`409`, siempre queda **al menos un** `ADMIN` activo y hay **un solo** `ROLE_CHANGED`
  - **Atomicidad:** con un trigger temporal que hace fallar la inserción de `ROLE_CHANGED`, el rol no cambia y la respuesta es un `500` JSend sin detalles
  - CORS: el preflight `PATCH` está permitido
- [x] Suite completa en verde (secuencial) y chequeos de mutación: quitar el bloqueo de los `ADMIN`, la revalidación del actor o la regla del último `ADMIN` debe hacer fallar las pruebas
Criterio: todos los criterios de aceptación del issue cubiertos.
Resultado: 50 archivos · 1265 pruebas en verde (secuencial); 37 unitarias del módulo `users` y 24 de integración en `users-role.test.ts`.
- **Hallazgo de diseño durante la implementación:** con la decisión 3 (actor revalidado como `ADMIN` activo y distinto del destino), la regla del último `ADMIN` queda **garantizada por construcción**, porque siempre queda al menos el actor. El `409` se mantiene como invariante defensiva y se prueba con unitarias del servicio. La prueba de integración "único `ADMIN` + segundo `ADMIN` inactivo" no es alcanzable, porque ese actor recibe `403`.
- **En la carrera de dos `ADMIN`:** el segundo se revalida tras el commit del primero y recibe `403`, así que nunca quedan 0 `ADMIN`.
- **Bloqueo:** se usa `FOR NO KEY UPDATE` en lugar de `FOR UPDATE`. Solo cambia `role`, columna no clave, y así no se bloquean los `KEY SHARE` de las FK de otras operaciones (p. ej. un `ADMIN` que borra recetas mientras otro cambia roles).
- **Actor con JWT válido pero inexistente:** recibe `403`, porque la revalidación lo descarta antes. `P2003` → `401` queda como defensa en profundidad.
- **Mutaciones detectadas:**
  - sin la revalidación del actor → fallan 4 pruebas;
  - sin la revalidación ni el último `ADMIN` → falla la carrera (quedan 0 `ADMIN`);
  - sin el bloqueo de los `ADMIN` → falla la carrera.

### Fase 4 — Documentación, auditorías y cierre · Estado: Hecha
- [x] ADR-0008; nota en ADR-0007 (opción C implementada) y en ADR-0006 (extensión de `entityName`)
- [x] `docs/business_rules.md` (`RN-09`), `docs/roles.md` (matriz de permisos y "Cómo obtiene el rol"), `docs/data_model.md` (`entityName = "User"`, acción `ROLE_CHANGED`), `docs/sad.md` §6 (catálogo, CORS) y §7 (deja de ser "solo SQL manual"), `docs/prd.md` (§5 y nueva `HU-08`), `README.md` y `CHANGELOG.md`
- [x] Auditorías con 3 subagentes en paralelo (solo lectura, **sin** tocar la base) y resolución de hallazgos
- [x] Archivar el plan; commit sugerido `feat(users): agregar administración de roles auditada para ADMIN` — *commit/push/PR solo con confirmación*
Criterio: auditorías aprobadas, suite en verde y listo para el PR.

## Resultado final
- `npm run typecheck`, `npm run typecheck:test`, `npm run build` y `npm test` en verde: 50 archivos · 1267 pruebas (secuencial); `dist/` sin tests.

## Auditorías (3 subagentes en paralelo, solo lectura y sin tocar la base)
- **security-auditor:** sin VETO. Confirma que se respeta el orden de guardas y que el RBAC más la revalidación del actor, el bloqueo en orden fijo y la protección contra BOPLA impiden escaladas e interbloqueos.
  - Media (riesgo asumido): un `ADMIN` o un `CHEF` degradado sigue operando fuera de este endpoint hasta `1d` → **documentado** en ADR-0008, con la rotación de `JWT_SECRET` ante una revocación urgente (#51), y **fijado con una prueba** (el `CHEF` degradado aprueba con su token anterior).
  - Baja: un `ADMIN` degradado podía distinguir `404` de `403` → **resuelto**. El servicio ya no busca al destino antes: primero va la auto-modificación (pura), luego la revalidación del actor y recién entonces el `404`. Se eliminó `findById` del repositorio.
  - Baja: sin rate limit → **documentado** como riesgo asumido en `docs/sad.md` §7.
  - Informativas: comentario `FOR UPDATE` → **corregido**; `ROLE_CHANGED` sin IP ni request-id y `audit_logs` mutable en la base → riesgo ya documentado.
- **code-reviewer:** aprobado.
  - Bajas → **resueltas**:
    - `RN-01` a `RN-09` en `docs/sad.md` §4;
    - el `403` por actor no activo y el `409` del último `ADMIN` en el catálogo de errores;
    - la rama `P2003` inalcanzable eliminada, porque la fila del actor queda bloqueada.
  - Nits → **resueltos**: la fila del `README` al final de la tabla, `hasPrismaErrorCode` duplicado eliminado y `ADMIN` → `ADMIN` propio = `403` documentado en `RN-09`.
  - **Pendiente de visto bueno humano:** sumar `RN-09` a las "Reglas inviolables" de `AGENTS.md` y a `.agents/agents/code-reviewer.md` (configuración de los agentes).
- **qa-tester:** aprobado.
  - Media → **resuelto**: prueba del riesgo asumido (un `CHEF` degradado aprueba con su JWT anterior; el nuevo login trae `USER`).
  - Bajas → **resueltas**: `message` del `403` por actor no activo, `auditLog.count() = 0` en `400`/`404`, la degradación de un `ADMIN` inactivo y `403` para un `ADMIN` degradado incluso con un id inexistente.

## Preguntas abiertas (resueltas: entra en el MVP y opciones recomendadas; triage cerrado en #53)
1. **¿Entra en el MVP?** El ticket recomendaba incluirlo **solo si el TP se despliega más allá de la evaluación**: el seed ya cubre los 4 roles para evaluar, y el PRD §5 deja fuera el KYC. Si entra, cierra el "solo SQL manual" de `docs/sad.md` §7 con un camino auditado (costo moderado: módulo nuevo, sin migración). Si no, propongo sacarlo del milestone `v0.1.0` y dejarlo `needs-triage` para una fase posterior. **Necesito tu decisión.**
2. **Auto-modificación y último `ADMIN`.** Recomendado: **prohibir** que un `ADMIN` cambie su propio rol (`403`) y que el sistema quede sin ningún `ADMIN` activo (`409`).
3. **Revalidar al actor en la base para esta operación.** Recomendado: **sí**, dentro de la transacción y con lock, de modo que un `ADMIN` degradado o desactivado no pueda seguir cambiando roles con su JWT vigente. No cambia `RN-08` para el resto de la API ni requiere migración. La alternativa es confiar solo en el JWT, con una ventana de hasta `1d`.
4. **Activar o desactivar cuentas.** Recomendado: **endpoint separado** (`PATCH /api/v1/users/:id/status`) en otro ticket.
5. **Cambio al mismo rol.** Recomendado: **`200` idempotente sin registrar auditoría**. La alternativa es `409`, que es menos amigable para clientes que reintentan.
6. **ADR-0008 y `RN-09`.** Recomendado: **sí**, porque implementa la opción C de ADR-0007 y extiende la convención de `audit_logs` (`entityName = "User"`).

## Riesgos
- **Superficie privilegiada nueva:** cualquier fallo de autorización equivale a una escalada total. Por eso se prueba la matriz de roles, la revalidación del actor y la carrera; el criterio de VETO de la auditoría de seguridad aplica con más rigor.
- **Tokens vigentes:** el rol nuevo rige recién desde el próximo login (hasta `1d`). Para un corte inmediato hay que rotar `JWT_SECRET` (#51) o implementar revocación (fuera de alcance).
- **Interbloqueos:** el orden fijo de bloqueo (primero los `ADMIN`, después el destino) evita ciclos. La carrera determinista lo verifica.
