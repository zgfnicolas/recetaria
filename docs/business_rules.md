# Reglas de negocio

## Recetas

### RN-01 — Estado inicial, autoría y slug automático
Toda receta creada mediante `POST /api/v1/recipes` nace en estado `DRAFT`, asigna `authorId` exclusivamente desde el usuario autenticado (`req.user.id`) y genera automáticamente su `slug` único en formato `<titulo-normalizado-ascii>-<8-hex>` (minúsculas, sin tildes ni `ñ`, truncado a ≤ 200 caracteres, sufijo aleatorio `crypto.randomBytes(4).toString("hex")`) a partir de `title`.
- Origen: requisito funcional del MVP y control de identidad
- Se aplica en: `RecipeService.create()`

### RN-02 — Propiedad exclusiva de edición y reinicio a borrador
Solo el autor original (`recipe.authorId === req.user.id`) puede modificar su receta mediante `PUT /api/v1/recipes/:id` (payload parcial o completo con al menos 1 campo válido); cualquier otro usuario recibe `403 Forbidden`. Si la receta estaba en estado `APPROVED`, la edición la devuelve automáticamente a `DRAFT`, limpia `reviewedById` y `publishedAt`, regenera el `slug` si cambió el `title`, y registra `action = 'RESET_TO_DRAFT'` (`entityName = 'Recipe'`) en `audit_logs` dentro de `prisma.$transaction`. Si la receta ya estaba en `DRAFT`, se actualiza normalmente sin insertar un registro en `audit_logs`. La decisión de reiniciar se toma sobre la fila bloqueada (`SELECT … FOR UPDATE`) dentro de la transacción, de modo que una aprobación concurrente nunca deja `APPROVED` un contenido editado sin revisar. Solo se actualizan los campos enviados (sin defaults); `null` vacía únicamente los opcionales (`nutritionalInfo`, `coverImageUrl`, `videoUrl`). El registro guarda en `oldValues`/`newValues` el ciclo de vida (`status`, `reviewedById`, `publishedAt`) y en `newValues.changedFields` la lista ordenada de campos editados (incluye `slug` cuando se regenera por un cambio de `title`), sin duplicar su contenido. Toda edición de una receta `APPROVED` la reinicia, aunque los valores enviados coincidan con los actuales.
- Origen: integridad de autoría y preservación de la validez clínica tras modificaciones
- Se aplica en: la política pura `canEdit()` (`src/modules/recipes/recipe.policy.ts`), `RecipeService.update()` y `RecipeRepository.updateWithOptionalReset()`

### RN-03 — Borrado físico autorizado con trazabilidad
Solo el autor original (`recipe.authorId === req.user.id`) o un usuario con rol `ADMIN` pueden eliminar una receta (`DELETE /api/v1/recipes/:id`), devolviendo `403 Forbidden` en otro caso y `404 Not Found` si no existe. La eliminación física se ejecuta dentro de `prisma.$transaction` insertando previamente en `audit_logs` un registro con `action = 'DELETE'` y `oldValues` (snapshot de `title`, `authorId`, `status`). El snapshot se toma de la fila bloqueada (`SELECT … FOR UPDATE`) dentro de la transacción, de modo que registra el `title` realmente confirmado; `newValues` queda en SQL `NULL`. Un borrado concurrente que espera el lock ya no encuentra la fila y recibe `404`, así que solo queda un `DELETE` auditado. Si el actor tiene un JWT válido pero ya no existe en `users` (`P2003` sobre `fk_audit_logs_user`), se responde `401` sin borrar. Ante éxito se responde `200` con `data: { id }`. Además, no se permite eliminar físicamente un usuario que tenga recetas asociadas (`ON DELETE RESTRICT`).
- Origen: requisito CRUD del TP, moderación de plataforma y trazabilidad de auditoría
- Se aplica en: la política pura `canDelete()` (`src/modules/recipes/recipe.policy.ts`), `RecipeService.delete()` y `RecipeRepository.deleteWithAudit()`, que dentro de la transacción bloquea al actor (`SELECT … FOR SHARE`) y reevalúa `canDelete()` con su rol vigente antes de bloquear la receta (ADR-0009): desactivado → `401`, `ADMIN` degradado sobre una receta ajena → `403`

### RN-04 — Validación profesional exclusiva y prevención de doble aprobación
Únicamente los usuarios autenticados con rol `CHEF` o `NUTRITIONIST` pueden aprobar una receta (`PUT /api/v1/recipes/:id/approve`); un rol `USER` o `ADMIN` recibe `403 Forbidden`. Si la receta ya se encuentra en estado `APPROVED`, el servicio rechaza la operación con `409 Conflict`. **Bloqueo optimista (#46):** la aprobación exige el header `If-Match` con el `ETag` fuerte de la versión revisada (lo devuelve `GET /api/v1/recipes/:id`):
  - sin `If-Match`, o con `*`, responde `428 Precondition Required` antes de consultar la base;
  - con una sintaxis inválida, responde `400`;
  - si la versión ya no es la vigente, responde `412 Precondition Failed` sin escribir. Así nunca se aprueba un contenido distinto del que el revisor leyó.

  La versión se verifica sobre la fila bloqueada (`SELECT … FOR UPDATE`). Antes, dentro de la misma transacción, se bloquea al revisor (`SELECT … FOR SHARE`) y se reevalúa `canApprove()` con su rol vigente (ADR-0009): si fue desactivado mientras tanto → `401`, y si fue degradado → `403`. Orden de guardas: `401` → `403` RBAC → `428` → `400` → `404` → `403` (`RN-05`) → `412` → `409`.
- Origen: propuesta de valor clínica y gastronómica de Recetaria
- Se aplica en: `rbacMiddleware(RECIPE_APPROVER_ROLES)` (`['CHEF', 'NUTRITIONIST']`), la política pura `canApprove()` (`src/modules/recipes/recipe.policy.ts`), `requireIfMatchMiddleware({ singleTag: true })` (un único ETag; una lista → `400`) y `RecipeService.approve()`. La versión y el estado se verifican sobre la fila bloqueada en `RecipeRepository.approveWithAudit()` (`412`/`409`), con el `UPDATE` condicional `status = 'DRAFT'` como guarda adicional

### RN-05 — Separación de funciones en aprobación
Quien crea una receta no puede aprobarla (`recipe.authorId !== reviewerId`). Cualquier intento de auto-aprobación devuelve `403 Forbidden`.
- Origen: auditoría independiente y prevención de auto-validación
- Se aplica en: `canApprove()` + `RecipeService.approve()`, con defensa en profundidad en la base (`CHECK chk_recipes_reviewer_not_author`)

### RN-06 — Trazabilidad transaccional en cambios críticos
Las operaciones de aprobación (`APPROVE`), reinicio por edición desde `APPROVED` (`RESET_TO_DRAFT`) y eliminación (`DELETE`) deben ejecutarse dentro de una transacción ACID (`prisma.$transaction`) que garantice consistencia entre `recipes` y `audit_logs` usando siempre `entityName = 'Recipe'`.
- Origen: trazabilidad profesional y auditoría inmutable
- Se aplica en: `RecipeRepository.approveWithAudit()`, `RecipeRepository.updateWithOptionalReset()` y `RecipeRepository.deleteWithAudit()`

### RN-07 — Validaciones de dominio en servicio
Además de la validación estructural estricta con Zod 4 (`z.strictObject`) en el middleware, `RecipeService` exige explícitamente que `prepTimeMinutes` sea un entero entre `1` y `1440` (24 horas) y que `ingredients` incluya al menos un ingrediente y que **cada** ingrediente tenga `quantity > 0`, acumulando todos los incumplimientos en un único `400 Bad Request`.
- Origen: requisito 5 de la consigna (validaciones de negocio en capa de servicio) y constraint SQL `chk_prep_time_positive`
- Se aplica en: `RecipeService.create()` y `RecipeService.update()`

### RN-09 — Administración de roles exclusiva de `ADMIN`, auditada y sin perder la moderación
Solo un `ADMIN` puede cambiar el rol de otro usuario mediante `PATCH /api/v1/users/:id/role` (body estricto `{ role }`; otro rol → `403` en RBAC). Reglas:
- **No auto-modificación:** un `ADMIN` no puede cambiar su propio rol (`403`), ni siquiera pidiendo el que ya tiene (`ADMIN` → `ADMIN`): la regla se evalúa antes que la idempotencia.
- **Revalidación del actor:** dentro de la transacción y con lock, el actor debe seguir siendo un `ADMIN` activo en la base. Un `ADMIN` degradado o desactivado con JWT vigente recibe `403`.
- **Último `ADMIN`:** el cambio nunca deja el sistema sin `ADMIN` activo (`409`, invariante defensiva). Los `ADMIN` activos se bloquean (`SELECT … FOR NO KEY UPDATE`), así que dos `ADMIN` que se degradan a la vez se serializan.
- **Idempotencia:** asignar el rol actual responde `200` sin registrar auditoría.
- **Auditoría atómica:** el `UPDATE` del rol y el registro en `audit_logs` (`entityName = 'User'`, `action = 'ROLE_CHANGED'`, `userId` del `ADMIN`, `oldValues`/`newValues = { role }`) van en la misma `prisma.$transaction`.
- **Vigencia:** el rol nuevo rige **de inmediato** en toda la API, porque `authMiddleware` resuelve el rol vigente del actor (ADR-0009); el próximo login lo refleja también en el JWT.

Orden de guardas: `401` → `403` RBAC → `400` → `403` auto-modificación → `403` actor no activo → `404` → `409` → `200`. El actor se revalida antes de buscar al destino, así que un `ADMIN` degradado no puede distinguir usuarios existentes (`404` vs `403`).
- Origen: ADR-0007 (opción C) y ADR-0008; gestión auditada de roles privilegiados (OWASP API5)
- Se aplica en: `rbacMiddleware(["ADMIN"])`, la política pura `canChangeRole()` (`src/modules/users/users.policy.ts`), `UserAdminService.changeRole()` y `UserAdminRepository.changeRoleWithAudit()`

### RN-10 — Activación y desactivación de cuentas exclusiva de `ADMIN` y auditada
Solo un `ADMIN` puede activar o desactivar la cuenta de otro usuario mediante `PATCH /api/v1/users/:id/status` (body estricto `{ isActive: boolean }`, sin coerción). Reglas:
- **No auto-modificación:** un `ADMIN` no puede cambiar el estado de su propia cuenta (`403`).
- **Revalidación del actor:** dentro de la transacción y con lock, igual que `RN-09`.
- **Último `ADMIN`:** nunca se desactiva al último `ADMIN` activo (`409`, invariante defensiva).
- **Idempotencia:** pedir el estado actual responde `200` sin auditar.
- **Auditoría atómica:** el `UPDATE` de `isActive` y el registro `ACCOUNT_DEACTIVATED`/`ACCOUNT_ACTIVATED` (`entityName = 'User'`, `oldValues`/`newValues = { isActive }`) van en la misma `prisma.$transaction`.
- **Efecto inmediato:** desactivar corta **todas** las operaciones protegidas del usuario en la siguiente solicitud (`401`, ADR-0009) y su login (`401`, `RN-08`). Sus recetas no cambian: siguen publicadas con su autoría y aprobación.

Orden de guardas: `401` → `403` RBAC → `400` → `403` auto-modificación → `403` actor no activo → `404` → `409` → `200`.
- Origen: moderación de cuentas sin borrado físico (`fk_recipes_author` es `RESTRICT`), #56
- Se aplica en: `authMiddleware` (`resolveActor`), la política pura `canChangeStatus()` (`src/modules/users/users.policy.ts`), `UserAdminService.changeStatus()` y `UserAdminRepository.changeStatusWithAudit()`

## Estados de una receta

```mermaid
stateDiagram-v2
    [*] --> DRAFT: POST /api/v1/recipes (Autor)
    DRAFT --> APPROVED: PUT /api/v1/recipes/:id/approve (CHEF / NUTRITIONIST != Autor)
    APPROVED --> DRAFT: PUT /api/v1/recipes/:id (Autor edita receta aprobada)
    DRAFT --> [*]: DELETE /api/v1/recipes/:id (Autor / ADMIN)
    APPROVED --> [*]: DELETE /api/v1/recipes/:id (Autor / ADMIN)
```

## Usuarios y Autenticación

### RN-08 — Identificación única, cuentas activas y resguardo de credenciales
Cada usuario se identifica de forma única por su `email` (`409 Conflict` si ya existe). El registro público (`POST /api/v1/auth/register`) crea **siempre** un usuario `USER` asignado por el servidor; enviar `role` (con cualquier valor) responde `400` "Campo no permitido" y los roles privilegiados solo se obtienen por seed (#48, ADR-0007). La contraseña nunca se almacena ni se registra en logs en texto plano: se cifra con Bcrypt usando al menos `10` *salt rounds*. En `POST /api/v1/auth/login`, los usuarios inactivos (`isActive === false`), correos inexistentes o claves erróneas reciben el mismo `401 Unauthorized` genérico (comparación timing-safe contra hash ficticio cuando no existe el email) sin revelar causa específica; la autenticación es por JWT sin sesiones, pero la **autorización usa el estado vigente del actor** (ADR-0009, #56): `authMiddleware`, tras verificar el token, resuelve al usuario en la base y opera con su `role` actual; un usuario inexistente o con `isActive = false` recibe `401` con el mensaje genérico de token inválido (no revela si la cuenta existe o está suspendida), y un fallo de la base al resolverlo responde `5xx`, nunca `401`. Además, `JWT_EXPIRES_IN` admite **como máximo `1d`** (86 400 s), validado al arrancar (`src/config/env.ts`) y al firmar (`assertValidJwtConfig`), con la regla compartida de `src/config/jwt-expires-in.ts` (#52). Al verificar, se rechazan los tokens sin `exp`/`iat`, con una antigüedad mayor a `1d` o con una vigencia declarada `exp - iat` mayor a `1d`. Contra fuerza bruta y *credential stuffing*, `POST /api/v1/auth/login` admite como máximo **10 intentos fallidos por IP** y **20 por cuenta** (email normalizado) cada 15 minutos —los inicios de sesión exitosos no consumen cuota— y `POST /api/v1/auth/register` admite **5 solicitudes por hora por IP**; al superarlos se responde `429 Too Many Requests` con el mismo mensaje genérico exista o no la cuenta, sin llegar a consultar la base ni a ejecutar Bcrypt.
- Origen: buenas prácticas OWASP y protección de identidad
- Se aplica en: `AuthService.register()`, `AuthService.login()`, `createAuthMiddleware({ resolveActor })` con `AuthService.resolveActiveActor()` (estado vigente del actor, ADR-0009) y los rate limits de `createAuthRouter` (`src/modules/auth/auth.rate-limit.ts`)
