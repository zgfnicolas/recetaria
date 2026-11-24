# 7. Registro público sin asignación de rol

Fecha: 2026-11-24
Estado: Aceptada (reemplaza parcialmente a ADR-0005 en el punto "`role` opcional en `/auth/register`")

## Contexto
ADR-0005 habilitó `role` opcional en `POST /api/v1/auth/register` (`USER`, `CHEF`, `NUTRITIONIST` o `ADMIN`) para facilitar la evaluación del MVP. Con el ciclo de vida completo (#19, #20, #21) eso pasó a ser una vulnerabilidad explotable por cualquier visitante anónimo (#48, OWASP API5 BFLA / API3 mass assignment):
- Un `ADMIN` auto-registrado puede **borrar físicamente y de forma irreversible todo el catálogo** (`DELETE /api/v1/recipes/:id`).
- Un `CHEF`/`NUTRITIONIST` auto-registrado puede **aprobar recetas de terceros** y darles un respaldo clínico o culinario falso, lo que vacía la propuesta de valor (`docs/prd.md` §1).

La auditoría de seguridad de #21 lo marcó como **bloqueante para Beta** (`docs/sad.md` §7). La evaluación ya dispone de los 4 usuarios del seed idempotente (`prisma/seed.ts`, solo `development|test`).

## Opciones consideradas
1. **A — Quitar `role` del registro en todos los entornos.** El servidor asigna siempre `USER` y los roles privilegiados solo se obtienen por seed o SQL manual.
2. **B — Flag de entorno validado** (`ALLOW_SELF_ROLE_ASSIGNMENT`, prohibido con `NODE_ENV=production`).
3. **C — Endpoint de administración de roles** (`PATCH /api/v1/users/:id/role`, solo `ADMIN`, auditado).

## Decisión
Opción **A**. `registerSchema` (`z.strictObject`) deja de declarar `role`, así que **cualquier** `role` en el body, incluido `"USER"`, responde `400` "Campo no permitido" por el mismo camino BOPLA que el resto de la API. `AuthService.register` asigna `SELF_REGISTERED_ROLE = "USER"`.

## Motivos
- Es la opción más simple y elimina el camino por completo, en lugar de condicionarlo a la configuración. B deja un interruptor peligroso que una mala configuración de despliegue puede habilitar.
- Rechazar también `role: "USER"` mantiene una regla uniforme (sin casos especiales en el esquema) y no revela qué roles existen.
- El seed ya cubre la evaluación de los 4 roles. C es el modelo correcto a futuro, pero amplía el alcance del MVP; queda diferido.

## Consecuencias
- (+) Se cierra la escalada de privilegios anónima (BFLA/mass assignment) y el riesgo bloqueante para Beta.
- (+) No hay código nuevo en el borde: lo resuelve el `z.strictObject` existente.
- (−) **Cambio de contrato de `HU-01`:** los clientes (incluida la colección Thunder Client, #6) que envíen `role` reciben `400`.
- (−) Fuera de `development|test` no hay forma de crear `CHEF`/`NUTRITIONIST`/`ADMIN` salvo SQL manual, hasta implementar la opción C o KYC.
- (−) Los JWT privilegiados emitidos antes del cambio siguen siendo válidos hasta `JWT_EXPIRES_IN`, por la autenticación stateless (`RN-08`).
