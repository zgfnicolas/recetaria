# Plan — #22 [Spec 06.1] Suite End-to-End del ciclo de vida y matriz de seguridad OWASP

Fecha: 2026-11-24 · Rama propuesta: `test/22-e2e-owasp-suite` (desde `main` con #57 mergeado) · Parent: `#6` · Estado: **Completado y archivado (2026-11-25); pendiente commit/PR**

## 1. Objetivo
Consolidar en una suite de regresión de punta a punta, sobre la costura `buildApp({ prisma })` + Supertest + PostgreSQL 15 real, la evidencia de que:
- los módulos `Health`, `Auth`, `Recipes` y `Users` colaboran en el ciclo de vida completo de una Receta, con el historial de auditoría exacto;
- cada vector OWASP crítico está cerrado;
- las fronteras de la arquitectura en 4 capas (ADR-0003) se respetan de forma verificable.

El cambio es **solo de pruebas y documentación**: no toca `src/`, migraciones ni `package.json`.

## 2. Estado actual (análisis)
| Criterio de #22 | Cobertura hoy | Brecha |
|---|---|---|
| Ciclo de vida completo con `audit_logs` | Fragmentada: `recipes-create`, `-approve`, `-update`, `-delete`, cada una con datos propios | No hay **un** recorrido encadenado con la secuencia exacta `APPROVE → RESET_TO_DRAFT → APPROVE → DELETE` |
| Rutas privadas por defecto | `auth-guards` prueba rutas sintéticas (`/protected/*`) y casos sueltos | Ninguna prueba **recorre las rutas registradas** ni falla si se agrega una ruta nueva sin `authGuard` |
| BOPLA / BOLA / BFLA / auto-aprobación / inactivo / JWT | Cubiertos por separado en `auth-*`, `recipes-*`, `users-*` (por ejemplo `alg: none`, firma inválida y expirado en `auth-guards:377`) | Falta una **matriz única** trazable a OWASP API Top 10 y a `RN-xx` contra las rutas reales |
| Sin `passwordHash` ni *stack traces* | Aserciones puntuales por suite | No hay una verificación **transversal** sobre todas las respuestas de la suite |
| Fronteras de capas (ADR-0003) | Solo por convención y por revisión | No hay prueba automatizada |

**Inventario de importadores de Prisma:** hoy solo importan `infrastructure/database`, `generated/prisma` o `@prisma/*` los tres `*.repository.ts`, `infrastructure/database/prisma.ts` y la raíz de composición (`app.ts`, `server.ts`, `bootstrap/container.ts`). La regla ya se cumple, así que la prueba nueva nace en verde y fija la invariante.

**Contexto que el ticket no menciona** (el ticket es anterior a #46, #48, #53 y #56):
- la aprobación exige `If-Match` con el `ETag` del detalle (#46);
- `/register` crea siempre `USER` (#48), así que `CHEF`, `NUTRITIONIST` y `ADMIN` deben obtenerse de otra forma;
- existen `RN-09` (`/role`) y `RN-10` (`/status`), y la autorización usa el estado vigente del actor (ADR-0009).

## 3. Diseño propuesto
Nueva carpeta `tests/e2e/`, que el `include` de Vitest ya cubre con `tests/**/*.test.ts`, más `tests/architecture/`.

### 3.1 `tests/e2e/recipe-lifecycle.test.ts` — ciclo de vida encadenado
Un único `it` secuencial (los pasos dependen entre sí; `sequence.shuffle` solo reordena entre pruebas), con *Arrange* mínimo:
1. Siembra **solo** un `ADMIN` inicial, como en producción (seed o SQL manual, ADR-0008).
2. `POST /auth/register` de autor, chef y nutricionista → `201`, siempre `USER`.
3. El `ADMIN` promueve con `PATCH /users/:id/role` a `CHEF` y `NUTRITIONIST` → `ROLE_CHANGED` ×2. Esto ejercita `RN-09` y ADR-0009, porque el rol rige de inmediato.
4. `POST /auth/login` de cada actor → JWT.
5. Alta `POST /recipes` → `201`, `DRAFT`, `authorId` del token, `slug` `<titulo>-<8hex>` (`RN-01`).
6. Lecturas:
   - `GET /recipes` (público, la incluye);
   - `GET /recipes/mine` (autor);
   - `GET /recipes/:id` → `ETag "1"`.
7. `PUT /:id/approve` por el `CHEF` con `If-Match` → `200`, `APPROVED`, `reviewedById`, `publishedAt` (`RN-04`).
8. `PUT /:id` por el autor → `DRAFT`, limpia la firma (`RN-02`).
9. `GET /:id` → nuevo `ETag`. El `If-Match` viejo daría `412`, y se verifica en el mismo paso.
10. `PUT /:id/approve` por el `NUTRITIONIST` con el `ETag` nuevo → `200`.
11. `DELETE /:id` por el `ADMIN` → `200`, `GET /:id` → `404` (`RN-03`).
12. **Assert final:** `audit_logs` con `entityName = "Recipe"` ordenado por `createdAt, id` es exactamente `[APPROVE, RESET_TO_DRAFT, APPROVE, DELETE]`, con `userId`, `entityId` y `oldValues`/`newValues` esperados. Además, los `User` son `[ROLE_CHANGED, ROLE_CHANGED]`.

### 3.2 `tests/e2e/private-routes-by-default.test.ts` — rutas privadas por defecto
- **Descubrimiento real de rutas:**
  - `buildApiRouters(...)` expone `[{ path, router }]` con los prefijos de montaje.
  - Se recorre `router.stack` de cada router (capas con `route.path` y `route.methods`, API estable de Express 5) y se suman las rutas de nivel superior de `app.router.stack` (`/health`, `/health/ready`).
- **Completitud:** el conjunto descubierto debe ser **igual** a un catálogo declarado en la prueba, con la columna `public: boolean`. Así, una ruta nueva hace fallar la prueba hasta que se clasifica explícitamente, y una ruta eliminada del código también.
- **Por cada ruta no pública** (`:id` reemplazado por un UUID v4 aleatorio y body vacío), tres variantes:
  - sin `Authorization`;
  - `Bearer` con firma inválida;
  - JWT válido de un id inexistente.

  Todas deben dar `401` JSend, nunca `2xx` ni `4xx` de validación: el `authGuard` corre antes que Zod.
- **Por cada ruta pública:** responde sin token y no `401`.
- **Autoverificación:** una app de prueba con una ruta montada sin `authGuard` hace fallar el chequeo, para demostrar que la prueba no es tautológica.

### 3.3 `tests/e2e/owasp-abuse-matrix.test.ts` — matriz de abuso
Tabla `it.each` con columnas `OWASP | RN | actor | request | status esperado | sin efecto en la base`, contra las rutas reales:

| Vector | Casos |
|---|---|
| **API3 BOPLA** (`z.strictObject`) | `role`/`isActive` en `register`; `status`/`authorId`/`reviewedById`/`slug` en `POST` y `PUT /recipes`; campos extra en `/role` y `/status` → `400` |
| **API1 BOLA** | Editar o borrar una receta ajena (`USER`, `CHEF`) → `403`; `ADMIN` editando una receta ajena → `403` (`RN-02`) |
| **API5 BFLA** | `USER`/`ADMIN` aprobando → `403` (`RN-04`); `USER`/`CHEF`/`NUTRITIONIST` en `/role` y `/status` → `403` (`RN-09`/`RN-10`) |
| **Auto-aprobación** | El autor `CHEF` aprobando su propia receta → `403` (`RN-05`) |
| **API2 cuenta inactiva** | Login de un inactivo → `401` con el **mismo** body que una contraseña errónea y que un email inexistente (`RN-08`); JWT vigente de un desactivado → `401` (ADR-0009) |
| **API2 manipulación de JWT** | `alg: none`, firma inválida, expirado, `alg` distinto de `HS256`, sin `exp` y claim `role` inflado (la base manda) → `401`/`403` |
| **API8 exposición** | Ver §3.4 |

Cada caso verifica además que no se escribió nada (conteo de `recipes`/`audit_logs`/rol sin cambios). Los casos que ya existen en suites específicas **no se borran**: la matriz es la vista consolidada y trazable, y las suites específicas siguen cubriendo los bordes.

### 3.4 Verificación transversal de exposición
Un helper `recordingAgent(app)` envuelve Supertest y guarda cada respuesta de las suites e2e. En `afterAll`, ninguna respuesta puede contener:
- `passwordHash`;
- un hash Bcrypt (`/\$2[aby]\$\d{2}\$/`);
- un *stack trace* (`/\n\s+at\s/` o `"stack"`);
- `JWT_SECRET`.

Se fuerza al menos un `500` real (el espía de `findUnique` rechazando, como en `auth-current-state`) para comprobar que su body sale redactado.

### 3.5 `tests/architecture/layer-boundaries.test.ts` — fronteras ADR-0003
- Recorre `src/**/*.ts` (sin `generated/` ni `*.test.ts`) y extrae los especificadores de `import`/`export … from`/`import()` con una expresión regular, sin dependencias nuevas.
- **Regla 1:** ningún `*.router.ts`, `*.controller.ts`, `*.service.ts`, `*.policy.ts`, `*.schema.ts` ni `src/middlewares/**` importa `@prisma/*`, `generated/prisma` ni `infrastructure/database`.
- **Regla 2:** los únicos importadores permitidos de Prisma son una *allowlist* explícita (`*.repository.ts`, `infrastructure/database/**` y la raíz de composición). Un importador nuevo fuera de la lista falla.
- **Regla 3 (orden de capas):** los controladores no importan repositorios y los routers no importan servicios ni repositorios. Para ambos casos se aceptan los `import type` usados para el cableado.
- **Autoverificación:** el extractor se prueba con *fixtures* en memoria (import estático, `export from`, dinámico, `import type`).

### 3.6 Documentación
- `docs/testing.md`: niveles (agrega E2E y arquitectura), matriz OWASP ↔ `RN` ↔ archivo de prueba, nota sobre `tests/e2e/` y `tests/architecture/`, y `412`/`428`/`429` en la matriz HTTP.
- `CHANGELOG.md`.
- `README.md`: mención breve en la sección de pruebas.

## 4. Fases
### Fase 1 — Triage, rama y registro del plan · Estado: Hecha
- [x] Resolver las preguntas de §6.
- [x] Crear la rama desde `main` actualizado.

### Fase 2 — Ciclo de vida E2E (§3.1) · Estado: Hecha
- [x] `tests/e2e/recipe-lifecycle.test.ts` y helpers en `tests/support/` si hacen falta.

### Fase 3 — Rutas privadas por defecto (§3.2) · Estado: Hecha
- [x] Descubrimiento, catálogo, tres variantes y autoverificación.

### Fase 4 — Matriz OWASP y exposición (§3.3, §3.4) · Estado: Hecha

### Fase 5 — Fronteras de arquitectura (§3.5) · Estado: Hecha

### Fase 6 — Verificación, documentación, auditorías y cierre · Estado: Hecha
Resultado: 56 archivos · 1416 pruebas en verde (secuencial); `dist/` sin tests. Único cambio en `src/`: la guarda de `iat` futuro en `jwt.ts`.
- **Decisiones durante la implementación:**
  - los casos BOPLA verifican el **campo** rechazado, porque un `400` por otro motivo (un `firstName` corto) los hacía pasar por el motivo equivocado;
  - la regla de capas acepta los `import type` (`RecipeRecord` en `recipe.policy.ts`), pero la de Prisma no.
- **Mutaciones:**
  - `strictObject` → `object` en recetas → fallan 2 de la matriz;
  - un servicio que importa Prisma → fallan 2 de arquitectura;
  - `RESET_TO_DRAFT` renombrado → falla el ciclo;
  - quitar `authGuard` de `/status` o de `/mine` **no** abre la ruta (defensa en profundidad: `rbacMiddleware` y `readActorId` responden `401`), así que la detección de una fuga real se demuestra con la autoverificación del router sin guarda.
- [x] `npm run typecheck`, `npm run typecheck:test`, `npm run build` y `npm test` (secuencial).
- [x] Mutaciones:
  - quitar `authGuard` de una ruta → falla §3.2;
  - aceptar campos extra en un esquema → falla §3.3;
  - importar Prisma en un servicio → falla §3.5;
  - quitar `RESET_TO_DRAFT` → falla §3.1.
- [x] Documentación (§3.6), auditorías `qa-tester`, `security-auditor` y `code-reviewer`, y archivar el plan.

## 5. Riesgos
- **Tiempo de ejecución:** el ciclo E2E corre varios Bcrypt (`>= 10` rounds). Cuesta segundos, no minutos, y queda dentro del `testTimeout` de 15 s; si hiciera falta, el *timeout* se eleva solo en esa prueba.
- **Introspección de Express:** `router.stack[].route` es estable en Express 5, pero no es API documentada como contrato. Si un *upgrade* la rompe, la prueba falla ruidosamente, no en silencio, porque la completitud exige que el catálogo coincida.
- **Rate limits:** las apps de las suites se construyen con `publicRateLimit: false` y `authRateLimit: false`, como en el resto de las suites. Los límites tienen pruebas propias.

## 6. Preguntas abiertas (resolverlas cierra el triage)
1. **Alcance de las reglas:** el ticket dice `RN-01`–`RN-08`, pero hoy existen `RN-09`/`RN-10`, ETag (#46) y ADR-0009. ¿Las incluyo en la matriz y en el ciclo? *Recomendado: sí. La suite tiene que reflejar la postura de seguridad actual, no la del momento en que se escribió el ticket.*
2. **Cómo obtener `CHEF`/`NUTRITIONIST`/`ADMIN` en el E2E:**
   - (a) insertarlos directo en la base con el helper `createUserWithRole`;
   - (b) sembrar solo el `ADMIN` inicial, registrar a los demás por HTTP y promoverlos con `PATCH /users/:id/role`.

   *Recomendado: (b). Es el flujo real tras #48 y ADR-0008 y prueba `ROLE_CHANGED` de punta a punta.*
3. **Rutas privadas por defecto:**
   - (a) descubrimiento real de rutas más un catálogo declarado que debe coincidir;
   - (b) solo un catálogo manual.

   *Recomendado: (a). Detecta rutas nuevas sin clasificar, que es justamente el riesgo que el criterio quiere cerrar.*
4. **Fronteras de capas:** ¿solo importaciones **directas** de Prisma, como dice el ticket, o también el orden de capas (regla 3)? Las importaciones transitivas a través de los `index.ts` de cada módulo quedan fuera: los servicios importan tipos de repositorio legítimamente. *Recomendado: directas más regla 3, sin dependencias nuevas como `dependency-cruiser`, que exigiría modificar `package.json`.*

## Auditorías (3 subagentes en paralelo, solo lectura y sin tocar la base)
- **security-auditor:** sin VETO.
  - **Media, hueco real en `src/modules/auth/jwt.ts`:** se acepta un `iat` futuro. Un token con `iat = ahora + 10 años` y `exp = iat + 1h` cumple `exp - iat ≤ 1d` y `maxAge`, así que la vigencia de #52 queda anulada si se filtra el secreto. Lo **reproduje** (`verifyAccessToken` lo acepta). → **resuelto a pedido del humano** en este PR, en un commit `fix(auth)` aparte: rechazar `iat > ahora + JWT_CLOCK_TOLERANCE_SECONDS` (30 s). Lleva unitarias con reloj fijo, una fila en la matriz y un chequeo de mutación (sin la guarda fallan 3). `RN-08` queda actualizada.
  - Bajas → **resueltas**:
    - patrón de stack con `\\n` escapado en el JSON;
    - el descubrimiento falla ante un `use(path, fn)` (con autoverificación);
    - matriz: id no UUID, token en query y en cookie, `ADMIN` degradado y desactivado, `428` y `/mine?authorId=`.
- **qa-tester:** aprobado.
  - Medias → **resueltas**:
    - regla de barrel: ninguna capa superior importa como valor `*Repository`/`Prisma`, con autoverificación y mutación;
    - BOLA por query;
    - BOPLA `status`/`authorId` en `PUT`.
  - Bajas → **resueltas**:
    - exposición en `afterAll` con `try/finally`;
    - `oldValues` de la segunda `APPROVE`;
    - el orden de `audit_logs` documentado;
    - el rótulo de auto-modificación.
- **code-reviewer:** aprobado.
  - Medias → **resueltas**:
    - `use(path, fn)` no omitido;
    - `stripComments` respeta strings y template literals;
    - `import()` no literal → violación explícita.
  - Bajas → **resueltas**:
    - los `as` reemplazados por *type guards*;
    - el comentario del espía del `500`;
    - la precisión de `docs/testing.md`.
  - Nits → **resueltos**: `E2E_JWT_CONFIG` y `truncateAll` en `tests/support/e2e.ts`; la fecha del plan.
  - Se conserva el `login` local del ciclo, porque registra la respuesta en el *recorder* de exposición y `loginAs` no.
