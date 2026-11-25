# Plan: [Spec 03.7] Endpoint de activación y desactivación de cuentas (PATCH /api/v1/users/:id/status) restringido a ADMIN y auditado (#56)

Fecha: 2026-11-24 · Rama: `feat/56-account-status-endpoint` · Parent: `#3` · Estado: **Completado y archivado (2026-11-24); pendiente commit/PR**

## Objetivo
1. **`PATCH /api/v1/users/:id/status`:** un `ADMIN` desactiva o reactiva cuentas, con el cambio y el registro `ACCOUNT_DEACTIVATED`/`ACCOUNT_ACTIVATED` en la misma transacción, dentro del módulo `users` de #53.
2. **Opción (b) de la decisión 3:** `authMiddleware`, después de verificar la firma del JWT, **resuelve al actor contra la base** (`id`, `role`, `isActive`) y usa su **estado y rol actuales**. Un usuario desactivado, borrado o con un token de un id inexistente recibe `401`; uno degradado opera con su rol nuevo. Así, desactivar o cambiar un rol rige **de inmediato en toda la API**, y desaparece la ventana de hasta `1d` del JWT vigente (riesgo residual de #19, #21, #52 y #53).

## Por qué la (b) (decisión del humano, 2026-11-24)
Es el patrón estándar en un monolito con base propia (Passport `deserializeUser`, Spring `UserDetailsService`, Django `request.user`): el JWT **identifica** y la base **autoriza** con el estado vigente (OWASP ASVS y JWT Cheat Sheet: autorización sobre el estado actual del servidor y revocación efectiva). El costo es una consulta por clave primaria por request autenticado. La alternativa canónica a gran escala (access token corto + refresh revocable) requiere `sessions`, que el PRD §5 deja fuera del MVP.

## Contexto que el agente debe leer
- `AGENTS.md`, `docs/business_rules.md` (`RN-08`, `RN-09`), `docs/roles.md`, `docs/sad.md` §4/§6/§7, `docs/adr/0004-autenticacion-jwt-stateless-y-contrato-jsend.md` (**"100 % stateless"**, que esta decisión reemplaza en parte), ADR-0007, ADR-0008
- Código:
  - `src/middlewares/auth.middleware.ts` (`createAuthMiddleware`, `authenticateWithSecret` síncrono, `authMiddleware` por defecto con `JWT_SECRET` de entorno)
  - `src/middlewares/rbac.middleware.ts` (lee `req.user.role`)
  - `src/bootstrap/container.ts` (`authGuard`)
  - `src/modules/auth/user.repository.ts` (`findById`) y `auth.service.ts`
  - `src/modules/users/*` (`changeRoleWithAudit`, bloqueo en orden fijo, `ManagedUser`)
- Pruebas: `src/middlewares/auth.middleware.test.ts`, `tests/integration/http/auth-guards.test.ts`, `users-role.test.ts`, `recipes-approve.test.ts`, `recipes-delete.test.ts`, `recipes-create.test.ts` y `tests/support/users.ts`

## Análisis del estado actual
- **Capas:** `authMiddleware` es transporte y **no puede llamar a Prisma** (`AGENTS.md`). La consulta entra por inyección de dependencias:
  - `createAuthMiddleware({ secret, resolveActor })`, donde `resolveActor(id): Promise<Actor | null>`;
  - la implementación concreta es un método de `AuthService` (p. ej. `resolveActiveActor`), que delega en `UserRepository.findById`;
  - el contenedor lo cablea en `buildApiRouters`.
- **Middleware asíncrono:** Express 5 propaga los rechazos de handlers `async` a `next(err)`. Un fallo de la base (PostgreSQL caído) debe terminar en `503`/`500` redactado (`error-handler`), **nunca** en `401`.
- **`authMiddleware` por defecto (`JWT_SECRET` de entorno):** solo lo usan sus propias pruebas unitarias (no está montado en `src/`). Sin acceso a la base no puede aplicar la regla. Propuesta: **retirarlo** junto con sus pruebas, dejando `createAuthMiddleware` como única fábrica (pregunta 7).
- **`resolveActor` obligatorio:** con el tipo exigido, una ruta protegida no puede montarse por error en modo stateless. `rbacMiddleware` no cambia: ya lee `req.user.role`, que pasa a ser el rol **de la base**.
- **Impacto en pruebas existentes** (cambian expectativas, no comportamiento deseado):
  - las que construyen `createAuthMiddleware({ secret })` a mano (`auth-guards`, `recipes-create` y `recipes-update` en sus apps con slug fijo) deben pasar un `resolveActor`;
  - las que usan JWT de **ids inexistentes** pasan a recibir `401` del middleware, con el mensaje genérico de token inválido: el `ADMIN` fantasma de `recipes-delete` y `users-role`, y el revisor fantasma de `recipes-approve`;
  - los `ADMIN` degradados o desactivados de `users-role` pasan a `403` por RBAC (degradado) y `401` (desactivado), antes de llegar a la revalidación del repositorio;
  - la prueba "riesgo asumido: el `CHEF` degradado sigue aprobando con su JWT anterior" (`users-role.test.ts`) **se invierte**: ahora debe dar `403`, y pasa a demostrar que el riesgo se cerró.
- **Lo que se mantiene:** en `changeRoleWithAudit` (y en `/status`) la revalidación **dentro de la transacción con lock** sigue siendo necesaria para la carrera entre dos `ADMIN`. El middleware lee el estado antes de que la transacción empiece. Igual que las ramas `P2003 → 401` de `recipes`, queda como defensa en profundidad.
- **Ventana residual mínima:** una solicitud ya autenticada mientras otra transacción degrada o desactiva al actor puede completarse (milisegundos). Es aceptable y queda documentado. Las operaciones de administración la cierran con lock.
- **No hace falta migración:** `isActive` y la PK ya existen.

## Decisiones propuestas
1. **`authMiddleware` resuelve al actor en la base (opción (b)):**
   - `AuthService.resolveActiveActor(id)` → `{ id, role }` si el usuario existe y `isActive`; si no, `null`;
   - el middleware usa `{ id, role: rolDeLaBase }`; con `null` → `401` con el mismo mensaje genérico que un token inválido, para no distinguir causas;
   - si `resolveActor` lanza → `next(err)`, sin `401`.
2. **`PATCH /api/v1/users/:id/status`:**
   - `changeStatusSchema = z.strictObject({ isActive: z.boolean() })`;
   - `canChangeStatus` (pura) prohíbe la auto-desactivación;
   - `changeStatusWithAudit` comparte con `changeRoleWithAudit` los helpers de bloqueo extraídos (`lockActiveAdmins`, `lockManagedUser`), con estos resultados:
     - actor revalidado → `403`;
     - destino inexistente → `404`;
     - mismo estado → `200` sin auditar;
     - desactivar al último `ADMIN` activo → `409` (invariante);
     - en otro caso, `UPDATE` + registro `ACCOUNT_DEACTIVATED`/`ACCOUNT_ACTIVATED` con `{ isActive }`;
   - responde `200` con `{ id, email, role, isActive }`;
   - orden de guardas: `401` → `403` RBAC → `400` → `403` auto-desactivación → `403` actor no activo → `404` → `409` → `200`.
3. **`ManagedUser` incorpora `isActive`**, y `/role` también lo devuelve (cambio aditivo).
4. **ADR-0009** "Autorización con el estado vigente del actor": reemplaza en ADR-0004 el punto "100 % stateless" (la autenticación sigue siendo por JWT sin sesiones; la autorización consulta la base). Ajustes en `RN-08`, regla nueva `RN-10` (activación y desactivación) y nota en ADR-0008.
5. **Fuera de alcance:** refresh tokens y `sessions`, borrar o listar usuarios, ocultar sus recetas, y caché de la resolución del actor (si hiciera falta, ticket aparte con una medición).

## Fases

### Fase 1 — Triage, rama y registro del plan · Estado: Hecha
- [x] Registrar las decisiones en #56 (la (b) y el resto) y pasarlo a `ready-for-agent`
- [x] Cambiar a `main`, traer el merge del PR #55 (`c3c69c7`) y crear la rama `feat/56-account-status-endpoint`
- [x] Mover #56 a `In Progress`
Criterio: decisiones aprobadas y rama creada desde el `main` actualizado.

### Fase 2 — Autorización con el estado vigente (opción (b)) · Estado: Hecha
- [x] `AuthService.resolveActiveActor` (y su método de repositorio, si `findById` no alcanza)
- [x] `createAuthMiddleware({ secret, resolveActor })` asíncrono, con `resolveActor` obligatorio; retirar el `authMiddleware` por defecto si se aprueba la pregunta 7
- [x] Cableado en `buildApiRouters` y helper de pruebas (`tests/support`) para armar el `resolveActor` real en las apps de prueba
- [x] Migrar las pruebas afectadas (lista del análisis); `npm run typecheck && npm run typecheck:test && npm run build && npm test`
Criterio: suite en verde, con **solo** los cambios de expectativa enumerados en el análisis, cada uno justificado.

### Fase 3 — `PATCH /api/v1/users/:id/status` · Estado: Hecha
- [x] Refactor de los helpers de bloqueo en `users.repository.ts` (las pruebas de `/role` siguen en verde, con `isActive` aditivo)
- [x] Esquema, política, servicio, repositorio, controlador, ruta y re-exports de `/status`
- [x] `npm run typecheck && npm run typecheck:test && npm run build && npm test`
Criterio: compilación estricta y suite en verde.

### Fase 4 — Pruebas · Estado: Hecha
- [x] Unitarias de `auth.middleware`:
  - actor resuelto → `req.user` con el rol **de la base**, aunque el token diga otro
  - `null` → `401` genérico
  - `resolveActor` que lanza → `next(err)`, sin `401`
  - `resolveActor` no se llama con token inválido o expirado ni sin header
  - `secret` ausente → `500`, como hoy
- [x] Unitarias de `/status`:
  - esquema: `isActive` estricto (`"false"`, `0`, `null` → `400`), BOPLA
  - política, servicio y controlador
- [x] `tests/integration/http/auth-current-state.test.ts` (efecto de la (b) en toda la API):
  - un usuario desactivado con JWT vigente → `401` en `/mine`, `POST /recipes`, `PUT`/`DELETE` propios
  - un `CHEF` degradado a `USER` → `403` al aprobar (riesgo de #53 **cerrado**)
  - un `ADMIN` degradado → `403` al borrar una receta ajena
  - un JWT de un id inexistente → `401`
  - un JWT con `role: "ADMIN"` de un `USER` real → se le trata como `USER` (`403` en rutas de `ADMIN`)
  - con la base caída (espía que lanza) → `500` o `503` redactado, **no** `401`
- [x] `tests/integration/http/users-status.test.ts`:
  - `200` desactivar y reactivar con 1 registro exacto; `200` idempotente
  - después de desactivar, **todas** las rutas protegidas del usuario dan `401` de inmediato y el login da `401`; después de reactivar, vuelve a operar
  - `400`, `401`, `403` (cada rol no `ADMIN`, auto-desactivación) y `404`
  - carrera determinista entre dos `ADMIN` que se desactivan mutuamente → `200` + `403`, siempre ≥ 1 `ADMIN` activo y un solo registro
  - *rollback* con trigger temporal → `500` redactado, `isActive` intacto
- [x] Suite completa en verde (secuencial) y chequeos de mutación:
  - que el middleware use el rol del token y no el de la base → fallan las pruebas de degradación
  - que ignore `isActive` → fallan las de desactivación
  - que se quite la revalidación con lock del repositorio → falla la carrera
  - que se quite la regla de auto-desactivación → fallan sus pruebas
Criterio: todos los criterios de aceptación de #56 cubiertos.
Resultado: 52 archivos · 1312 pruebas en verde (secuencial).
- **Expectativas de suites existentes que cambiaron, como anticipaba el análisis (10 pruebas):**
  - `auth-guards`: la prueba "opera 100 % stateless" se invirtió → el usuario desactivado da `401`;
  - `recipes-create`, `recipes-approve` y `recipes-delete`: los JWT de ids inexistentes dan `401` en el middleware, con el mensaje genérico;
  - `users-role`:
    - el `CHEF` degradado → `403` (riesgo cerrado);
    - el rol promovido rige de inmediato, incluso con el token anterior;
    - el `ADMIN` degradado da `403` por RBAC y el desactivado `401`;
    - el `ADMIN` fantasma da `401`.
- **Respuesta aditiva:** `isActive` en las respuestas de `/role`.
- **Decisión de diseño:** `resolveActiveActor` queda en la clase `AuthService` y no en `IAuthService` (segregación de interfaces: el controlador no lo necesita).
- **Mutaciones detectadas:**
  - middleware con el rol del token → fallan 4;
  - ignorar `isActive` → fallan 4;
  - `/status` sin la revalidación con lock → falla la carrera;
  - sin la regla de auto-desactivación → fallan 3.

### Fase 5 — Documentación, auditorías y cierre · Estado: Hecha
- [x] ADR-0009, con notas en ADR-0004 y ADR-0008
- [x] `RN-08` (la autorización consulta el estado vigente) y `RN-10`; `docs/roles.md` (matriz y "Cuentas inactivas")
- [x] `docs/data_model.md` (acciones `ACCOUNT_*`)
- [x] `docs/sad.md`: §4 y §6 (secuencia de `authMiddleware` y catálogo) y §7 (se **cierra** el riesgo "desactivado o degradado con JWT vigente"; queda la ventana de milisegundos)
- [x] `docs/prd.md` (§5 "Seguridad e identidad" y `HU-09`), `README.md` y `CHANGELOG.md` (`Cambiado`: autorización con el estado vigente; `Agregado`: `/status`)
- [x] Auditorías con 3 subagentes en paralelo (solo lectura, **sin** tocar la base) y resolución de hallazgos
- [x] Archivar el plan; commit sugerido `feat(auth): autorizar con el estado vigente del actor y agregar activación/desactivación de cuentas auditada` — *commit/push/PR solo con confirmación*
Criterio: auditorías aprobadas, suite en verde y listo para el PR.

## Resultado final
- `npm run typecheck`, `npm run typecheck:test`, `npm run build` y `npm test` en verde: 52 archivos · 1330 pruebas (secuencial); `dist/` sin tests.
- Ampliación: revalidación del actor con `FOR SHARE` en `approveWithAudit`/`deleteWithAudit` (ventana residual cerrada); mutación "sin revalidación" → fallan las 3 carreras nuevas.

## Auditorías (3 subagentes en paralelo, solo lectura y sin tocar la base)
- **security-auditor:** sin VETO.
  - No queda ningún camino para usar el token de una cuenta desactivada, degradada o inexistente.
  - Ningún fallo se convierte en `401`/`200` (*fail closed*), y no hay enumeración.
  - Media: ventana de milisegundos entre `authGuard` y las transacciones de aprobar y borrar → **resuelta a pedido del humano (2026-11-24)**: `FOR SHARE` del actor y reevaluación de `canApprove`/`canDelete` dentro de la transacción. Es un complemento de la (b), no un reemplazo por la (c): el middleware sigue siendo la regla general.
  - Baja: una lectura por PK por request → asumido, con el rate limit por usuario ya previsto.
  - Informativas → **resueltas**: "Se aplica en" de `RN-08` y la mayúscula, y "stateless" en `docs/compliance.md` y `docs/roadmap.md`.
- **code-reviewer:** aprobado.
  - Bajas → **resueltas**: `{ ..., isActive }` en HU-08, `RN-01..RN-10` en `docs/sad.md` y `README` y el orden del catálogo.
  - Nit: ADR-0007/0008 conservan su texto original (inmutables, con nota de Estado hacia ADR-0009).
- **qa-tester:** aprobado.
  - Medias → **resueltas**:
    - la prueba "la base manda sobre el claim" ahora usa un `DELETE` ajeno, que solo el middleware puede frenar, y detecta la mutación del rol del token;
    - las ramas `P2003 → 401` de `recipes` se cubren con un resolvedor permisivo;
    - el mensaje del `403` por actor no activo se verifica en las carreras de `/role` y `/status`.
  - Bajas → **resueltas**:
    - desactivar una cuenta ya inactiva, reactivar un `ADMIN` inactivo, auto-reactivación `403` y `ADMIN` degradado contra un id inexistente;
    - unitarias de `resolveActiveActor`;
    - un `5xx` estricto;
    - las rutas públicas ignoran el token de un desactivado;
    - la aprobación con el JWT nuevo.

## Preguntas abiertas (resueltas: opción (b) y recomendaciones; triage cerrado en #56)
3. ~~Token vigente del desactivado~~ → **resuelta: opción (b)**.
1. **Auto-desactivación.** Recomendado: **prohibida (`403`)**.
2. **Último `ADMIN` activo.** Recomendado: **prohibir (`409`)**, como invariante defensiva.
4. **Idempotencia.** Recomendado: **`200` sin auditar**.
5. **Recetas del usuario desactivado.** Recomendado: **no cambian**.
6. **¿`/role` devuelve también `isActive`?** Recomendado: **sí** (aditivo).
7. **Retirar el `authMiddleware` por defecto** (stateless, con `JWT_SECRET` de entorno, sin uso en `src/`). Recomendado: **sí**, porque no puede aplicar la (b) sin la base y dejarlo abre un camino para montar rutas sin la regla. La alternativa es conservarlo marcado como obsoleto, sin uso.
8. **Mensaje del `401` para un desactivado o inexistente.** Recomendado: **el mismo mensaje genérico de token inválido** (`Token inválido o expirado`), para no revelar si la cuenta existe o está suspendida (coherente con `RN-08` en el login). La alternativa es uno específico ("cuenta desactivada"), más claro para el cliente pero con enumeración.

## Riesgos
- **Cambio transversal:** toca la autenticación de **todas** las rutas protegidas. La red de seguridad es la suite completa (~1270 pruebas) más las nuevas, ejecutada en forma secuencial.
- **Una consulta extra por request autenticado:** por PK, con un costo despreciable frente a Bcrypt o las transacciones existentes. Si apareciera un problema de rendimiento, la caché iría en un ticket aparte con una medición.
- **Dependencia de la base en la autenticación:** si PostgreSQL cae, las rutas protegidas fallan con `5xx` (antes podían autenticar). Es coherente, porque casi todas igual necesitan la base; `/health` no se ve afectado.
- **Cambio de contrato:** un token con un rol distinto al de la base pasa a regirse por la base. Los clientes que dependían de un token viejo de un usuario degradado o desactivado dejan de operar (es el objetivo).
