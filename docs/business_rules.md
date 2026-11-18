# Reglas de negocio

## Recetas

### RN-01 — Estado inicial, autoría y slug automático
Toda receta creada mediante `POST /api/v1/recipes` nace en estado `DRAFT`, asigna `authorId` exclusivamente desde el usuario autenticado (`req.user.id`) y genera automáticamente su `slug` único en `kebab-case` normalizado con sufijo único a partir de `title`.
- Origen: requisito funcional del MVP y control de identidad
- Se aplica en: `RecipeService.create()`

### RN-02 — Propiedad exclusiva de edición y reinicio a borrador
Solo el autor original (`recipe.authorId === req.user.id`) puede modificar su receta mediante `PUT /api/v1/recipes/:id` (payload parcial o completo con al menos 1 campo válido); cualquier otro usuario recibe `403 Forbidden`. Si la receta estaba en estado `APPROVED`, la edición la devuelve automáticamente a `DRAFT`, limpia `reviewedById` y `publishedAt`, regenera el `slug` si cambió el `title`, y registra `action = 'RESET_TO_DRAFT'` en `audit_logs` dentro de `prisma.$transaction`.
- Origen: integridad de autoría y preservación de la validez clínica tras modificaciones
- Se aplica en: `RecipeService.update()` y `RecipeRepository.updateWithOptionalReset()`

### RN-03 — Borrado físico autorizado con trazabilidad
Solo el autor original (`recipe.authorId === req.user.id`) o un usuario con rol `ADMIN` pueden eliminar una receta (`DELETE /api/v1/recipes/:id`), devolviendo `403 Forbidden` en otro caso y `404 Not Found` si no existe. La eliminación física se ejecuta dentro de `prisma.$transaction` insertando previamente en `audit_logs` un registro con `action = 'DELETE'` y `oldValues` (snapshot de `title`, `authorId`, `status`). Además, no se permite eliminar físicamente un usuario que tenga recetas asociadas (`ON DELETE RESTRICT`).
- Origen: requisito CRUD del TP, moderación de plataforma y trazabilidad de auditoría
- Se aplica en: `RecipeService.delete()` y `RecipeRepository.deleteWithAudit()`

### RN-04 — Validación profesional exclusiva y prevención de doble aprobación
Únicamente los usuarios autenticados con rol `CHEF` o `NUTRITIONIST` pueden aprobar una receta (`PUT /api/v1/recipes/:id/approve`); un rol `USER` o `ADMIN` recibe `403 Forbidden`. Si la receta ya se encuentra en estado `APPROVED`, el servicio rechaza la operación con `409 Conflict`.
- Origen: propuesta de valor clínica y gastronómica de Recetaria
- Se aplica en: `rbacMiddleware(['CHEF', 'NUTRITIONIST'])` y `RecipeService.approve()`

### RN-05 — Separación de funciones en aprobación
Quien crea una receta no puede aprobarla (`recipe.authorId !== reviewerId`). Cualquier intento de auto-aprobación devuelve `403 Forbidden`.
- Origen: auditoría independiente y prevención de auto-validación
- Se aplica en: `RecipeService.approve()`

### RN-06 — Trazabilidad transaccional en cambios críticos
Las operaciones de aprobación (`APPROVE`), reinicio por edición (`RESET_TO_DRAFT`) y eliminación (`DELETE`) deben ejecutarse dentro de una transacción ACID (`prisma.$transaction`) que garantice consistencia entre `recipes` y `audit_logs`.
- Origen: trazabilidad profesional y auditoría inmutable
- Se aplica en: `RecipeRepository.approveWithAudit()`, `RecipeRepository.updateWithOptionalReset()` y `RecipeRepository.deleteWithAudit()`

### RN-07 — Validaciones de dominio en servicio
Además de la validación estructural de Zod en el middleware, `RecipeService` exige explícitamente que `prepTimeMinutes` sea un entero entre `1` y `1440` (24 horas) y que `ingredients` incluya al menos un ingrediente con `quantity > 0` (`400 Bad Request`).
- Origen: requisito 5 de la consigna (validaciones de negocio en capa de servicio) y constraint SQL `chk_prep_time_positive`
- Se aplica en: `RecipeService.create()` y `RecipeService.update()`

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

### RN-08 — Identificación única y resguardo de credenciales
Cada usuario se identifica de forma única por su `email` (`409 Conflict` si ya existe). La contraseña nunca se almacena ni se registra en logs en texto plano: se cifra con Bcrypt usando al menos `10` *salt rounds*, y los fallos de login devuelven `401 Unauthorized` genérico sin revelar si falló el email o la clave.
- Origen: buenas prácticas OWASP y protección de identidad
- Se aplica en: `AuthService.register()` y `AuthService.login()`
