# 9. Autorización con el estado vigente del actor

Fecha: 2026-11-24
Estado: Aceptada (reemplaza parcialmente a [ADR-0004](0004-autenticacion-jwt-stateless-y-contrato-jsend.md) en el punto "autenticación 100 % stateless": la autenticación sigue siendo por JWT sin sesiones; la **autorización** consulta el estado vigente del actor)

## Contexto
ADR-0004 adoptó un Bearer JWT 100 % stateless: `authMiddleware` confiaba en el `{ id, role }` del token durante toda su vigencia. Con el ciclo de vida completo, eso dejó una ventana de exposición de hasta `JWT_EXPIRES_IN` (acotada a `1d` en #52) en la que:
- un `CHEF`/`NUTRITIONIST` desactivado o degradado seguía **aprobando** recetas (#19, riesgo documentado en #53);
- un `ADMIN` desactivado o degradado seguía **borrando recetas ajenas** (#21);
- una cuenta desactivada seguía creando, editando y listando sus recetas.

#56 incorpora la desactivación de cuentas (`PATCH /api/v1/users/:id/status`). Sin un efecto inmediato, desactivar tendría poca utilidad como herramienta de moderación.

## Opciones consideradas
1. **(a)** Mantener 100 % stateless y documentar la ventana (con rotación de `JWT_SECRET` ante una urgencia).
2. **(b)** `authMiddleware` resuelve al actor en la base en cada request autenticado y usa su `role` e `isActive` actuales.
3. **(c)** Revalidar al actor solo en las operaciones privilegiadas (aprobar, borrar ajeno, administrar).
4. Access tokens cortos + refresh tokens revocables (requiere `sessions`, fuera del MVP según el PRD §5).

## Decisión
Opción **(b)**:
- `createAuthMiddleware({ secret, resolveActor })` verifica la firma y la vigencia del JWT y luego llama a `resolveActor(id)` (`AuthService.resolveActiveActor` → `UserRepository.findById`, por inyección para respetar las 4 capas).
- `req.user` queda con el **rol de la base**. Un usuario inexistente o con `isActive = false` recibe `401`, con el mismo mensaje genérico que un token inválido (no revela si la cuenta existe o está suspendida).
- Un fallo de la base al resolver se propaga como `5xx` redactado, **nunca** como `401`.
- `resolveActor` es **obligatorio**. Se retiró el `authMiddleware` por defecto (stateless sobre `JWT_SECRET` de entorno, sin uso en `src/`), para que ninguna ruta pueda montarse sin la regla.
- Las rutas públicas no se ven afectadas (no consultan `users`).

## Motivos
- Es el patrón estándar en un monolito con base propia (Passport `deserializeUser`, Spring `UserDetailsService`, Django `request.user`): el token **identifica** y la base **autoriza**. Es coherente con OWASP ASVS y el JWT Cheat Sheet: autorizar sobre el estado vigente del servidor y poder revocar efectivamente.
- Es uniforme: desactivar o cambiar un rol rige al instante en **toda** la API, a diferencia de (c), que deja dos modelos de autorización y obliga a recordar la revalidación en cada operación nueva.
- El costo es una lectura por clave primaria por request autenticado, despreciable frente a Bcrypt o las transacciones existentes.

## Consecuencias
- (+) Se cierran los riesgos residuales de #19, #21, #52 y #53 sobre tokens vigentes de cuentas desactivadas o degradadas.
- (+) La desactivación (#56) es una herramienta de moderación efectiva e inmediata.
- (−) La autorización depende de la base: si PostgreSQL no responde, las rutas protegidas fallan con `5xx` (casi todas ya dependían de la base).
- (+) **Ventana entre el middleware y la transacción cerrada en las operaciones privilegiadas:**
  - Las administrativas (`/role`, `/status`) revalidan al `ADMIN` con `FOR NO KEY UPDATE` (#53, #56).
  - La aprobación y el borrado (`approveWithAudit`, `deleteWithAudit`) bloquean primero la fila del actor con `SELECT … FOR SHARE` y reevalúan `canApprove`/`canDelete` con su rol vigente: inexistente o inactivo → `401`, sin permiso → `403`.
  - `FOR SHARE` es incompatible con el `FOR NO KEY UPDATE` de `/role` y `/status`, así que las dos operaciones se serializan. Si la degradación confirma antes, la operación la ve y se rechaza. Si la operación tomó el lock antes, era legítima al empezar y la degradación espera a que termine.
  - El orden de bloqueo es fijo (actor → receta) y ninguna transacción de `users` bloquea `recipes`, así que no hay ciclos.
- (−) Ventana residual de milisegundos solo en las operaciones no privilegiadas sobre contenido propio (`POST`, `PUT /:id`, lecturas de `/mine`): un Autor desactivado justo durante su solicitud puede completarla. Se acepta porque no otorga ningún privilegio.
- (−) Una lectura extra por request autenticado. Si alguna vez hiciera falta, una caché iría en un ticket aparte, con medición.
