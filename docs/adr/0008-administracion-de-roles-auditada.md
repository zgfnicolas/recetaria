# 8. Administración de roles auditada

Fecha: 2026-11-24
Estado: Aceptada (implementa la opción C diferida en ADR-0007 y extiende la convención de `audit_logs` de ADR-0006)

## Contexto
Desde ADR-0007 (#48), `POST /api/v1/auth/register` crea siempre `USER`, y **no había ningún camino en la API para otorgar o revocar `CHEF`, `NUTRITIONIST` o `ADMIN`**. Fuera de `development|test` (donde corre el seed) solo quedaba el SQL manual sobre `users`, sin control de acceso de la aplicación ni trazabilidad en `audit_logs`. #53 decidió incluir el endpoint en el MVP.

Hay dos fuerzas en juego:
- **Autenticación stateless (`RN-08`):** `rbacMiddleware` confía en el `role` del JWT, así que un `ADMIN` degradado o desactivado conserva su token hasta `1d` (#52).
- **Disponibilidad de la moderación:** si dos `ADMIN` se degradan mutuamente a la vez, el sistema no debe quedar sin ningún `ADMIN` activo.

## Opciones consideradas
1. Seguir con SQL manual, sin endpoint.
2. `PATCH /api/v1/users/:id/role` confiando solo en el JWT para autorizar.
3. `PATCH /api/v1/users/:id/role` con RBAC **y** revalidación del actor en la base, dentro de la misma transacción del cambio.

## Decisión
Opción **3**, en un módulo nuevo `src/modules/users/` (4 capas):
- `authGuard → rbacMiddleware(["ADMIN"]) → validateMiddleware({ params: UUID v4, body: z.strictObject({ role }) })`.
- En una transacción interactiva `READ COMMITTED` y con orden fijo de bloqueo:
  1. `SELECT … FOR NO KEY UPDATE` de **todos** los `ADMIN` activos;
  2. si el actor ya no es uno de ellos → `403` (antes de buscar al destino, para no revelar si existe);
  3. bloqueo del destino → `404` si no existe; mismo rol → `200` idempotente sin auditoría;
  4. si el cambio dejaría el sistema sin `ADMIN` activo → `409`, como invariante defensiva;
  5. `UPDATE` del rol y registro `ROLE_CHANGED` en `audit_logs`.
- Un `ADMIN` no puede cambiar su propio rol (`403`).
- `audit_logs` se extiende con `entityName = "User"` y `action = "ROLE_CHANGED"`, con `oldValues`/`newValues = { role }`. No requiere migración.

## Motivos
- La revalidación con lock cierra, **para la operación más privilegiada de la API**, la ventana de un `ADMIN` degradado con JWT vigente, sin cambiar `RN-08` ni introducir revocación (`tokenVersion`) en el resto.
- Bloquear el conjunto de `ADMIN` activos serializa los cambios entre administradores: en la carrera de dos `ADMIN` que se degradan entre sí, el segundo se revalida tras el commit del primero y recibe `403`. Con el actor revalidado y distinto del destino, siempre queda al menos un `ADMIN`, y el `409` queda como defensa en profundidad.
- `FOR NO KEY UPDATE` (solo cambia `role`, columna no clave) no bloquea los `KEY SHARE` de las FK de otras operaciones, como las inserciones en `audit_logs` del mismo `ADMIN`.

## Consecuencias
- (+) Los roles privilegiados se gestionan por la API con control de acceso y trazabilidad; deja de depender del SQL manual.
- (+) No se puede perder el último acceso de moderación por autodegradación ni por carreras.
- (−) El rol nuevo del **destino** rige desde su próximo login: su token vigente conserva el rol anterior hasta `1d` (`RN-08`) **en el resto de la API**. Un `ADMIN` degradado puede seguir borrando recetas ajenas, y un `CHEF`/`NUTRITIONIST` degradado aprobando, hasta que venza su token. Este endpoint sí revalida al actor. **Ante una revocación urgente hay que rotar `JWT_SECRET`** (runbook #51), lo que invalida todas las sesiones.
- (−) Sin rate limit propio (riesgo asumido, `docs/sad.md` §7).
- (−) Activar o desactivar cuentas (`isActive`) queda para un endpoint separado (ticket aparte).
