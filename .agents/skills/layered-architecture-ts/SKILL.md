---
name: layered-architecture-ts
description: >-
  Diseña, revisa y hace cumplir la arquitectura modular por capas en TypeScript
  para Recetaria API (Node 22, Express 5, Prisma, PostgreSQL, Zod, JSend): nivel
  por feature (L0/L1/L2), fronteras de dependencia verificables, API pública por
  módulo, composition root, errores AppError a JSend, transacciones ACID y testing
  por capa. Usar al diseñar nuevos módulos, estructurar src/, refactorizar capas,
  revisar dependencias o definir fronteras transaccionales.
---

# Arquitectura Modular por Capas — Recetaria API (TypeScript)

**Regla rectora:** las capas existen para controlar dependencias y la dirección del cambio, no para multiplicar archivos. Usá la arquitectura mínima que preserve reglas de negocio testeables sin HTTP ni DB, límites verificables y aislamiento de Express y Prisma.

**Prioridades:** Correctitud → Cohesión → Límites verificables → Testeabilidad → Observabilidad → Simplicidad.

## 1. Reglas duras (MUST)

- **Organización *feature-first*:** cada dominio vive en `src/modules/<feature>/` (`auth`, `recipes`) con sus capas adentro; `src/middlewares/` y `src/shared/` contienen solo piezas transversales sin lógica de negocio.
- **Dirección de dependencias:** `router/controller/schema` → `service` → `repository` (y `domain/` puro si sube a L2). Ni `controller` ni `service` importan `PrismaClient`; `service` nunca recibe `req`/`res`.
- **API pública por módulo:** un módulo consume a otro exclusivamente desde `src/modules/<feature>/index.ts` (tipos de lectura, DTOs o casos de uso exportados), nunca desde archivos internos. Sin ciclos entre módulos.
- **Validación y autorización en dos niveles:**
  - *Borde (`validateMiddleware` con Zod):* valida forma, tipos y UUIDv4 (`400 Bad Request`).
  - *Servicio (`*.service.ts`):* ejecuta reglas de negocio (`RN-01`–`RN-08` en `docs/business_rules.md`) y autorización de recurso (`authorId === req.user.id`, bloqueo de auto-aprobación `RN-05`).
- **Errores tipados → JSend centralizado:** `service` lanza subclases de `AppError` con código semántico; un único `errorHandlerMiddleware` traduce `AppError`, `ZodError` y errores Prisma (`P2002` → `409`, `P2025` → `404`) al sobre **JSend extendido** (`docs/sad.md`), logueando inesperados (`5xx`) una sola vez y sin exponer *stack traces* en producción.
- **Frontera transaccional explícita:** toda operación multi-escritura con auditoría (`APPROVE`, `RESET_TO_DRAFT`, `DELETE` según `RN-06`) corre dentro de `prisma.$transaction`. Nunca abras transacciones desde `controller` ni hagas I/O externo lento dentro de una transacción.
- **Composition root única:** instanciá `PrismaClient`, repositorios, servicios y controladores en `src/bootstrap/container.ts`. Separá `src/app.ts` (crea la app Express sin `listen()`, lista para Supertest) de `src/server.ts` (`listen()`, señales `SIGTERM`/`SIGINT` y `prisma.$disconnect()`).
- **Contexto explícito:** usá `AsyncLocalStorage` solo para correlación (`requestId` en logs). Pasá `actor` (`{ id, role }`) siempre como parámetro explícito al servicio.

## 2. Nivel de arquitectura por feature

Elegí el nivel por módulo según su complejidad real; distintos módulos pueden convivir en niveles distintos:

| Nivel | Cuándo elegirlo | Estructura dentro de `src/modules/<feature>/` |
|---|---|---|
| **L0 — Plano** | Recurso trivial sin reglas de negocio ni auditoría | `<f>.router.ts`, `<f>.schema.ts`, `<f>.service.ts`, `index.ts` |
| **L1 — Por capas (Estándar MVP)** | Varios casos de uso, validaciones de dominio, RBAC/ownership y tests sin HTTP (`auth`, `recipes`) | `<f>.router.ts`, `<f>.schema.ts`, `<f>.controller.ts`, `<f>.service.ts`, `<f>.repository.ts`, `index.ts` |
| **L2 — Centrado en dominio** | Invariantes complejas, múltiples adapters o consumidores (HTTP + colas/eventos en Fase Alfa/Beta) | `presentation/`, `application/` (casos de uso + `ports.ts` + `UnitOfWork`), `domain/` puro, `infrastructure/`, `index.ts` |

- **Cuándo subir a L2:** cuando aparece una regla compleja que conviene testear como entidad pura sin DB, un segundo adapter real o un segundo consumidor además de Express.
- **Cuándo bajar de nivel:** si una capa queda vacía o es puro pasamanos sin valor, eliminala.

## 3. Estructura de proyecto (Node 22 + Express 5 + Prisma)

```text
src/
├── app.ts                    # buildApp(container): loggerMiddleware, /health, /api/v1, errorHandler (sin listen)
├── server.ts                 # carga env, buildContainer(), app.listen(), graceful shutdown (SIGTERM/SIGINT)
├── bootstrap/container.ts    # composition root explícita (PrismaClient -> repositories -> services -> controllers)
├── config/env.ts             # parseo y validación Zod de process.env al arrancar
├── middlewares/              # logger, validate (Zod), auth (JWT), rbac, error-handler (JSend)
├── modules/
│   ├── auth/                 # L1: router, schema, controller, service, user.repository, index.ts
│   └── recipes/              # L1: router, schema, controller, service, recipe.repository, index.ts
└── shared/
    ├── errors/app-error.ts   # jerarquía AppError (400, 401, 403, 404, 409)
    └── http/jsend.ts         # helpers tipados de sobre JSend
```

*(Para contratos Zod, interfaces de `Auth` y `Recipes` y secuencia de creación de rutas, usá la skill `nuevo-endpoint`.)*

## 4. Patrones y tooling ejecutable (Referencia bajo demanda)

Consultá [`references/patterns-and-tooling.md`](./references/patterns-and-tooling.md) cuando necesites:
- Reglas ejecutables de `.dependency-cruiser.cjs` adaptadas a `src/modules/`, `src/middlewares/` y `src/shared/`.
- Implementación de referencia para `src/bootstrap/container.ts`, `src/app.ts` y `src/server.ts` (con *graceful shutdown* para Docker).
- Jerarquía `AppError` + traductor `errorHandlerMiddleware` a JSend.
- Patrón `UnitOfWork` sobre `prisma.$transaction` al escalar un módulo a L2.

## 5. Testing por capa

| Capa | Qué prueba | Dobles permitidos |
|---|---|---|
| **Domain** *(si L2)* | Invariantes y transiciones puras | Ninguno |
| **Service (`*.service.test.ts`)** | Reglas `RN-01`–`RN-08`, ownership, slug, errores | Fake o mock tipado únicamente del `Repository` |
| **Repository** | Queries Prisma, constraints SQL, `$transaction` | PostgreSQL real (Docker) |
| **HTTP / Presentation (`tests/`)** | Validación Zod, JWT, RBAC, formato JSend y códigos HTTP | Supertest contra `buildApp()` |
| **Wiring y Arquitectura** | Arranque de `buildContainer()` + `dependency-cruiser` en CI | Ninguno |

## 6. Antipatrones a evitar

- Carpetas globales `src/controllers/`, `src/services/`, `src/repositories/` fuera de `src/modules/<feature>/`.
- `PrismaClient` instanciado dentro de un servicio o controlador, o modelos ORM devueltos sin proyectar (`passwordHash` expuesto).
- Lógica de negocio (`RN-01`–`RN-08`) escondida en routers, middlewares o repositorios.
- `BaseRepository<T>` genérico sin necesidad, capas L2 vacías para CRUD simples o `src/shared/` convertido en cajón de sastre con lógica de dominio.
- Imports hacia archivos internos de otro módulo en lugar de su `index.ts`.
- `actor` o permisos ocultos en `AsyncLocalStorage` en vez de parámetros explícitos.

## 7. Definition of Done

Una entrega o revisión arquitectónica está terminada solo cuando se cumplen todos estos puntos:
- [ ] Cada feature declara su nivel (`L0`/`L1`/`L2`) y expone únicamente su API pública en `index.ts`.
- [ ] Cero ciclos de dependencias; `service` no importa Prisma ni Express (`req`/`res`); `shared/` no importa `modules/`.
- [ ] `src/app.ts` no llama a `listen()` y `src/server.ts` maneja `SIGTERM`/`SIGINT` cerrando el servidor y Prisma.
- [ ] Todos los errores pasan por `AppError` → `errorHandlerMiddleware` devolviendo JSend sin *stack traces* en producción.
- [ ] `APPROVE`, `RESET_TO_DRAFT` y `DELETE` corren dentro de `prisma.$transaction` (`RN-06`).
- [ ] `npm run build` compila en modo estricto sin `any` y `npm test` pasa en verde.
