# 5. Alcance del MVP, ciclo de vida de recetas y auditoría transaccional

Fecha: 2026-11-18
Estado: Aceptada (el punto "`role` opcional en `/auth/register`" fue reemplazado por [ADR-0007](0007-registro-publico-sin-asignacion-de-rol.md), #48)

## Contexto
Al contrastar la documentación inicial con la consigna del Trabajo Práctico Integrador (10 requisitos mínimos + 4 extras opcionales), surgieron ambigüedades: una tabla `sessions` sin endpoints en un sistema JWT stateless, cuatro estados de receta sin transiciones hacia `PENDING_REVIEW`/`REJECTED`/`ARCHIVED`, ocultamiento de borradores en `GET` públicos y falta de separación explícita entre validación de formato y reglas de negocio en `Service`.

## Opciones consideradas
1. Implementar endpoints extra para `sessions`, flujo multi-estado (`PENDING_REVIEW`, `REJECTED`, `ARCHIVED`) y baja lógica
2. Ajustar el MVP a 3 modelos activos (`User`, `Recipe`, `AuditLog`), ciclo de 2 estados (`DRAFT` ↔ `APPROVED`) con reinicio automático al editar, borrado físico con auditoría y separación Zod vs. `Service`

## Decisión
Adoptamos la opción 2 para el MVP:
- Eliminar la tabla `sessions` manteniendo autenticación 100 % stateless con JWT y 3 modelos activos (`User`, `Recipe`, `AuditLog`).
- Reducir `RecipeStatus` a `DRAFT` y `APPROVED`. Toda receta inicia en `DRAFT`; `PUT /api/v1/recipes/:id/approve` la pasa a `APPROVED`; si el Autor edita (`PUT /api/v1/recipes/:id`) una receta ya aprobada, vuelve automáticamente a `DRAFT` (`RESET_TO_DRAFT`), limpia `reviewedById` y `publishedAt` y registra el evento en `audit_logs`.
- Ejecutar `DELETE /api/v1/recipes/:id` como borrado físico dentro de `prisma.$transaction`, conservando en `audit_logs` (`action = 'DELETE'`) el snapshot previo sin FK bloqueante hacia `recipes`.
- Habilitar en `GET /api/v1/recipes` la visibilidad por defecto de `DRAFT` y `APPROVED` con filtros opcionales (`status`, `difficulty`, `authorId`), `role` opcional en `/auth/register` + usuarios semilla, `GET /health` y logging HTTP en consola.
- Separar validación de tipos/formato en middleware Zod de las reglas de negocio explícitas en `RecipeService` (`prepTimeMinutes` entre `1` y `1440`, `ingredients` con `quantity > 0`, ownership, bloqueo de auto-aprobación y detección de receta ya aprobada).

## Motivos
- Elimina tablas y estados muertos sin endpoints que las soporten dentro del plazo de 2 semanas.
- Preserva el diferencial de confianza clínica al impedir que una receta editada conserve la aprobación previa de un Nutricionista o Chef.
- Garantiza trazabilidad completa incluso tras el borrado físico requerido por la rúbrica del CRUD.

## Consecuencias
- (+) Todo modelo, enum y endpoint especificado es 100 % ejecutable y verificable en Thunder Client y Supertest
- (+) La capa `Service` concentra validaciones de negocio claras y testeables unitariamente
- (−) La gestión persistente de refresh tokens (`sessions`) y los estados `PENDING_REVIEW`/`REJECTED` quedan diferidos a fases posteriores si se incorporan flujos de revisión avanzados
