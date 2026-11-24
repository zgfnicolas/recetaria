# Plan: [Spec 03.4] Restringir la auto-asignación de roles en POST /api/v1/auth/register (BFLA/mass assignment) (#48)

Fecha: 2026-11-24 · Rama: `fix/48-register-role-restriction` · Parent: `#3` · Estado: **Completado y archivado (2026-11-24); pendiente commit/PR**

## Objetivo
Cerrar el riesgo marcado como **bloqueante para Beta** en `docs/sad.md` §7. Hoy cualquier visitante anónimo puede registrarse como `ADMIN` y borrar todo el catálogo (#21), o como `CHEF`/`NUTRITIONIST` y aprobar recetas de terceros (#19). Es un caso de BFLA y mass assignment (OWASP API5/API3).

El registro público creará **siempre** usuarios `USER`. Los roles privilegiados de evaluación seguirán disponibles por el seed idempotente (`npm run db:seed`, solo en `development|test`).

## Contexto que el agente debe leer
- `AGENTS.md`, `docs/prd.md` (`HU-01`, §5, §9), `docs/roles.md` (columna "Cómo obtiene el rol"), `docs/business_rules.md` (`RN-08`), `docs/sad.md` §7, `docs/adr/0005-alcance-mvp-ciclo-recetas-y-auditoria.md` (decidió `role` opcional en `/register`)
- Código: `src/modules/auth/auth.schema.ts` (`registerSchema.role`), `auth.service.ts` (`register` usa `dto.role`), `user.repository.ts`, `prisma/seed.ts` (4 usuarios, guarda de entorno)
- Pruebas afectadas: `auth-register.test.ts` (rol explícito por cada valor), `auth-login.test.ts` (registra `ADMIN`/`CHEF`), `auth-guards.test.ts` y `recipes-create.test.ts` (helper `registerAndLogin` con rol), más las unitarias `auth.schema.test.ts`, `auth.service.test.ts` y `auth.controller.test.ts`

## Análisis del estado actual
- **Una sola línea de código abre el hueco:** `role: z.enum(USER_ROLES).default("USER")` en `registerSchema`, que `AuthService.register` copia tal cual a `userRepository.create`. Como `registerSchema` es `z.strictObject`, basta con **quitar** `role` para que cualquier `role` enviado produzca `400 "Campo no permitido"`, por el mismo camino BOPLA que el resto de la API y sin código nuevo.
- **Rol asignado por el servidor:** `AuthService.register` debe fijar `role: "USER"` explícitamente, igual que `RN-01` fija `status: "DRAFT"`. Así no depende de un default del esquema ni de la base.
- **El trabajo pesado son las pruebas.** Cuatro suites de integración registran usuarios privilegiados por HTTP. Hay que migrarlas a un helper de pruebas que **siembre** el usuario con su rol por Prisma (Bcrypt real, para poder hacer login) y obtenga el JWT por `POST /auth/login`. Así se sigue ejercitando el login real sin depender de `role` en `/register`.
- **Decisión de arquitectura previa:** ADR-0005 decidió "`role` opcional en `/auth/register` + usuarios semilla". Revertirla se registra en una **ADR nueva** (`0007`) que la reemplaza en ese punto, en lugar de editar la ADR histórica.
- **Entornos productivos:** el seed está bloqueado fuera de `development|test`, así que tras este cambio **no existe ningún camino para crear `CHEF`/`NUTRITIONIST`/`ADMIN` en producción**, salvo SQL manual. Es aceptable para el MVP (el TP se evalúa en desarrollo), y la opción C (endpoint de administración) queda como ticket posterior.
- **Tokens ya emitidos:** un JWT privilegiado emitido antes del cambio sigue siendo válido hasta `JWT_EXPIRES_IN`, porque la autenticación es stateless (`RN-08`). Está fuera de alcance según el ticket.

## Decisiones propuestas
1. **Estrategia A** *(pregunta 1)*: quitar `role` de `registerSchema` en **todos** los entornos, sin variable de entorno. Es la opción más simple y no deja un camino peligroso que una mala configuración pueda habilitar.
2. **`role` en el body → siempre `400` "Campo no permitido"**, incluido `role: "USER"` *(pregunta 2)*. La regla queda uniforme con BOPLA (#16/#20), no revela qué roles existen y no requiere un caso especial. Un cliente que hoy manda `role: "USER"` debe dejar de mandarlo; queda registrado como cambio de contrato.
3. **`AuthService.register`:** `role: "USER"` constante (`SELF_REGISTERED_ROLE`); `RegisterDTO` deja de tener `role`. La respuesta `201` sigue devolviendo `role: "USER"` para que el cliente lo vea.
4. **Helper de pruebas** `tests/support/users.ts` → `createUserWithRole(db, { email, role, password })`, que hace el hash con Bcrypt con 10 rounds (`RN-08`), y `loginAs(app, { email, password })`. Reemplaza los `registerAndLogin` duplicados de `auth-guards.test.ts` y `recipes-create.test.ts`, y los registros privilegiados de `auth-login.test.ts`.
5. **ADR-0007** "Registro público sin asignación de rol" *(pregunta 3)*: contexto (#48, #19/#21), decisión (A), alternativas descartadas (B flag de entorno; C endpoint admin, diferido), consecuencias y la indicación de que reemplaza ese punto de ADR-0005. ADR-0005 recibe una nota "Reemplazado parcialmente por ADR-0007".
6. **Fuera de alcance:** endpoint de administración de roles (C, ticket aparte si se prioriza), KYC, revocación de JWT y colección Thunder Client (#6, que deberá usar los usuarios del seed).

## Fases

### Fase 1 — Triage, rama y registro del plan · Estado: Hecha
- [x] Resolver las preguntas abiertas y pasar #48 de `needs-triage` a `ready-for-agent`, con un comentario de las decisiones
- [x] Crear la rama `fix/48-register-role-restriction` desde `main` (`e2ae129`, con #46 mergeado)
- [x] Mover #48 a `In Progress`
Criterio: decisiones aprobadas y rama creada.

### Fase 2 — Implementación · Estado: Hecha
- [x] Quitar `role` de `registerSchema` (y de `RegisterDTO` inferido); `AuthService.register` con `role: "USER"` fijo
- [x] Verificar que ningún otro consumidor dependa de `dto.role` (`auth.controller.ts`, `index.ts`)
- [x] `npm run typecheck && npm run typecheck:test && npm run build`
Criterio: compilación estricta; las pruebas que dependen de `role` en `/register` fallan de forma esperada y se migran en la Fase 3.

### Fase 3 — Pruebas · Estado: Hecha
- [x] `tests/support/users.ts` (`createUserWithRole`, `loginAs`), con pruebas mínimas propias o cubierto indirectamente por las suites que lo usan
- [x] Migrar `auth-guards.test.ts`, `recipes-create.test.ts` y `auth-login.test.ts` al helper, sin cambiar lo que verifican
- [x] `auth-register.test.ts`:
  - el registro sin `role` crea un `USER` (`201`)
  - **cada** rol (`USER`, `CHEF`, `NUTRITIONIST`, `ADMIN`) y valores inválidos (`"ROOT"`, `null`, `["ADMIN"]`) en `role` → `400` "Campo no permitido" sin crear el usuario (`count` en `users`); el mensaje no enumera roles
  - variantes de mass assignment: `Role`, `ROLE` y `isActive` en el body → `400`
- [x] **Prueba de punta a punta (BFLA):** registrar con `role: "ADMIN"` → `400`; registrar sin `role` y hacer login → el JWT trae `role: "USER"`; con ese token, `DELETE` de una receta ajena → `403` y `PUT /:id/approve` → `403`
- [x] Unitarias: `auth.schema.test.ts` (sin default de rol; `role` rechazado), `auth.service.test.ts` (persiste `USER` sin importar la entrada; el repositorio recibe `role: "USER"`) y `auth.controller.test.ts` si corresponde
- [x] Seed: la prueba existente `seed.test.ts` sigue verde (4 roles y guarda de entorno intactos)
- [x] Suite completa en verde, ejecutada **en forma secuencial**, y chequeo de mutación: si se reintroduce `role` en el esquema, la prueba de punta a punta falla
Criterio: todos los criterios de aceptación del issue cubiertos.
Resultado: 44 archivos · 1135 pruebas en verde, ejecutadas en forma secuencial.
- **Suites migradas al helper `tests/support/users.ts`:** `auth-guards` (14 llamadas), `recipes-create` (14) y `auth-login` (caso por rol). En todas, `USER` sigue pasando por el registro HTTP real y los roles privilegiados se siembran con Bcrypt real antes del login HTTP. Las aserciones de logs se ajustaron al número real de requests según el rol.
- **Mutaciones detectadas:**
  - (1) `role` reintroducido solo en el esquema → fallan 18 pruebas de esquema y registro;
  - (2) reintroducido en el esquema y en el servicio (la regresión real) → fallan 8, incluida la de punta a punta.

### Fase 4 — Documentación, auditorías y cierre · Estado: Hecha
- [x] `docs/adr/0007-registro-publico-sin-asignacion-de-rol.md` + nota en ADR-0005
- [x] `docs/prd.md` (`HU-01` y su criterio, §5 "Seguridad e identidad", §9 "Alta de roles para evaluación"), `docs/roles.md` (columna "Cómo obtiene el rol": solo seed para los privilegiados), `docs/business_rules.md` (`RN-08`: el registro siempre crea `USER`), `docs/sad.md` §7 (riesgo cerrado; checklist Beta actualizado), `README.md` (contrato de `/register` y cómo obtener los usuarios de evaluación) y `CHANGELOG.md` (`Cambiado`: cambio de contrato; `Seguridad`)
- [x] Auditorías con 3 subagentes en paralelo (solo lectura, **sin** tocar la base) y resolución de hallazgos
- [x] Archivar el plan; commit sugerido `fix(auth): impedir la auto-asignación de roles en el registro público` — *commit/push/PR solo con confirmación*
Criterio: auditorías aprobadas, suite en verde y listo para el PR.

## Resultado final
- `npm run typecheck`, `npm run typecheck:test`, `npm run build` y `npm test` en verde: 44 archivos · 1139 pruebas, ejecutadas en forma secuencial; `dist/` sin tests.
- **Mutaciones detectadas:**
  - `role` reintroducido en el esquema → fallan 18 pruebas;
  - reintroducido en el esquema y en el servicio → fallan 8, incluida la de punta a punta.

## Auditorías (3 subagentes en paralelo, solo lectura y sin tocar la base)
- **security-auditor:** sin VETO; no queda ningún camino público hacia un rol distinto de `USER`.
  - Medias (residuales del despliegue): los JWT privilegiados ya emitidos y las cuentas privilegiadas auto-registradas que ya existan → **documentados** como pasos obligatorios al desplegar en `docs/sad.md` §7 (rotar `JWT_SECRET`; auditar con `SELECT … WHERE role <> 'USER'`). El tope de `JWT_EXPIRES_IN` queda sugerido para un ticket aparte.
  - Baja: no hay alta de roles privilegiados en producción → asumido en ADR-0007.
- **code-reviewer:** aprobado.
  - Medias → **resueltas**: `docs/sad.md` §6 todavía decía "acepta `role` opcional", y el skill `.agents/skills/identity-sessions-authorization/SKILL.md` describía el contrato viejo.
  - Baja y nits → **resueltos**: imports `UserRole` sin uso y líneas en blanco dobles.
- **qa-tester:** apto.
  - Media → **resuelta**: prueba HTTP de login de los 4 usuarios del seed con su rol.
  - Bajas → **resueltas**: `__proto__`/`constructor` en el body, `?role=ADMIN` en la query, fixture del controlador renombrado (ya no `chef@`), comentario sobre el `If-Match` sin efecto en la prueba de punta a punta e imports sin uso.

## Preguntas abiertas (resueltas: estrategia A y recomendaciones; triage cerrado en #48)
1. **Estrategia.** Recomendado: **A — quitar `role` del registro en todos los entornos**. Alternativas: B (flag de entorno prohibido en producción) o C (endpoint de administración, que amplía el alcance del MVP; puede ir en un ticket posterior).
2. **`role: "USER"` explícito.** Recomendado: **`400` como cualquier otro valor**, uniforme y sin revelar roles. La alternativa es aceptarlo e ignorarlo por compatibilidad, con un caso especial en el esquema.
3. **ADR-0007.** Recomendado: **sí**, registrar la decisión que revierte el punto de ADR-0005. La alternativa es documentar solo en el PRD y `docs/roles.md`.
4. **Usuarios privilegiados fuera de `development|test`.** Recomendado: **aceptar que hoy solo se crean por seed (dev/test) o SQL manual**, y abrir un ticket para la opción C si se planea desplegar más allá de la evaluación. La alternativa es incluir C en este ticket.

## Riesgos
- **Cambio de contrato de `HU-01`:** clientes y la colección Thunder Client que envíen `role` recibirán `400`. Queda documentado en el `CHANGELOG` (`Cambiado`) y el PRD.
- **Migración de pruebas:** tocar 4 suites de integración puede alterar lo que verifican. El helper conserva el login real por HTTP y cada suite debe seguir con su mismo número de casos (o justificar el cambio).
- **Costo de Bcrypt en las pruebas:** el helper hace un hash por usuario sembrado (10 rounds, unos 70 ms). Es comparable al registro HTTP actual, así que no cambia el tiempo de la suite.
