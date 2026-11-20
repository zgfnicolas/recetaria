# 6. Estandarización de Node 24 LTS, ESM nativo, Prisma 7 GA y contratos API

Fecha: 2026-11-20
Estado: Aceptada

## Contexto
Al auditar la documentación, las configuraciones técnicas y las skills de ingeniería antes de implementar `src/`, surgieron incompatibilidades y ambigüedades:
- `package.json` mezclaba `@prisma/client@^7.10.1` con `prisma@^8.0.0-rc.33` y `prisma.config.ts` usaba `definePrismaConfig` (API v8 RC) sin `@prisma/adapter-pg`.
- Coexistían dos entrypoints (`src/index.ts` en `package.json`/`Dockerfile` vs. `src/server.ts` + `src/app.ts` en la arquitectura), dos órdenes de middlewares (`validate → auth` vs. `auth → validate`), sintaxis Zod v3 (`z.object`) sin protección BOPLA frente a Zod 4 instalado, y `GET /health` consultando PostgreSQL en el `HEALTHCHECK` de liveness.
- `package.json` declaraba `"@types/node": "^26"` mientras `Dockerfile` corría Node 22 en CommonJS con `ts-node-dev`, y `GET /api/v1/recipes` devolvía listas sin límite de paginación.

## Opciones consideradas
1. Mantener CommonJS + Node 22 + `ts-node-dev` y diferir ESM, paginación y alineación de Node/Prisma a una fase posterior.
2. Estandarizar desde el inicio en **Node 24 LTS + ESM nativo (`nodenext`) + `tsx` + Prisma 7 GA (`@prisma/adapter-pg`)**, separar `src/app.ts`/`src/server.ts`, ordenar middlewares por seguridad (`auth → rbac → validate`), separar `/health` (liveness) de `/health/ready` (readiness) y endurecer los contratos Zod 4 y de paginación.

## Decisión
Adoptamos la opción 2 como estándar único del proyecto:
- **Runtime y módulos:** Node.js **24 LTS** (`node:24-bookworm-slim`, `.node-version`, `engines`, `@types/node@^24`), **ESM nativo** (`"type": "module"`, `module: "nodenext"`, `moduleResolution: "nodenext"`, `target: "es2024"`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`) y **`tsx`** para desarrollo (`tsx watch src/server.ts`) y seeds.
- **Entrypoint:** separar **`src/app.ts`** (`buildApp` sin `listen()`, listo para Supertest) de **`src/server.ts` → `dist/server.js`** (`listen()`, manejo de `SIGTERM`/`SIGINT` y `prisma.$disconnect()`).
- **Persistencia:** alinear a **Prisma 7 GA** (`prisma@~7`, `@prisma/client@~7`, `@prisma/adapter-pg`, `pg`, `defineConfig` en `prisma.config.ts`), fijando `audit_logs.entityName = "Recipe"` y retirando índices redundantes (`idx_users_email`, `idx_recipes_slug`) y `ON UPDATE CASCADE` en PKs UUID inmutables.
- **Seguridad y contratos HTTP:**
  - Orden en rutas protegidas: **`authMiddleware → rbacMiddleware → validateMiddleware`**.
  - Validación en borde con **Zod 4 estricto** (`z.strictObject`, `z.email()`, `z.url()`, `z.uuid()`), acotando `tags` (≤ 20 ítems, ≤ 50 chars) y tipando `nutritionalInfo`, manteniendo las validaciones de negocio `RN-07` en `RecipeService`.
  - Salud separada: **`GET /health`** (liveness liviano sin DB para Docker `HEALTHCHECK`) y **`GET /health/ready`** (readiness con `SELECT 1` sobre PostgreSQL, retornando `200` o `503`).
  - Listado `GET /api/v1/recipes` con orden determinístico `("createdAt" DESC, id DESC)` y paginación opcional `?page=1&limit=20` (máximo `100`), devolviendo `data: { items, meta: { page, limit, total, totalPages } }`, más endpoint autenticado `GET /api/v1/recipes/mine` (registrado antes de `/:id`) para listar exclusivamente las recetas del autor autenticado.
  - `.env.example` mantenido únicamente con los nombres de variables vacíos (`KEY=`) cumpliendo el Requisito 10 del TP Integrador, con valores de desarrollo documentados en `README.md`.
  - `slug` normalizado ASCII con sufijo hexadecimal de 8 caracteres (`<titulo>-<8-hex>`, ≤ 200 chars); `audit_logs` registrado solo en `APPROVE`, `RESET_TO_DRAFT` (cuando estaba `APPROVED`) y `DELETE`; `users.isActive === false` rechazado con `401 Unauthorized` en `AuthService.login()`.
- **Testing:** **Vitest + Supertest** como único runner oficial (reemplazando la ambigüedad `Vitest / Jest`).
- **Hardening por fases:** aplicar en el MVP endurecimiento sin fricción (`Dockerfile` código read-only para `USER node`, `HEALTHCHECK` exec, `NODE_OPTIONS=--max-old-space-size=384`, `shm_size: 256m`) y diferir a **Fase Beta / Producción** `secrets:`/`*_FILE`, digest pinning `@sha256:...` y roles PostgreSQL separados (`recetaria_runtime`/`recetaria_migrator`).

## Motivos
- Elimina deuda técnica y fricción futura al arrancar `src/` directamente sobre ESM moderno, Node 24 LTS y Prisma 7 GA coherente.
- Evita reinicios en cascada en Docker al desacoplar `/health` de PostgreSQL, y previene ataques BOPLA/API4 mediante `z.strictObject` y paginación acotada.
- Deja un contrato único e inequívoco entre documentación, reglas de agentes, skills y tests.

## Consecuencias
- (+) Cero incompatibilidad entre `prisma` y `@prisma/client`, y cero divergencia entre docs y skills
- (+) Mejor seguridad de borde (`auth → rbac → validate`, `z.strictObject`, paginación acotada) y compatibilidad nativa con TS 7 / Vitest / `tsx`
- (−) Exige extensiones explícitas `.js` en imports relativos de TypeScript con `moduleResolution: "nodenext"` y una fase de saneamiento de `package.json`/`tsconfig.json`/`Dockerfile` antes de iniciar `src/`
