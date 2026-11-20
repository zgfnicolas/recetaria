---
name: typescript-engineering
description: >-
  Escribe, revisa y refactoriza código TypeScript estricto y conciso para Recetaria API
  (TS 7, Node.js 22+ LTS, Express 5, Zod 4, JSend) — endurecimiento de tsconfig y sintaxis
  borrable (erasableSyntaxOnly), type vs interface, uniones discriminadas, branded types,
  satisfies, assertNever, errores AppError y Result, OOP (#private) vs funcional,
  SOLID/KISS/DRY/YAGNI, complejidad Big-O (Map/Set/ES2025), límites medidos de archivo y
  complejidad cognitiva (ESLint/SonarJS/knip), guard clauses y async con AbortSignal.
  Usar al escribir lógica TypeScript, diseñar tipos/errores, refactorizar o revisar PRs.
---

# Ingeniería TypeScript (Recetaria API)

Baseline: **TypeScript 7** (`"typescript": "^7.0.2"` en [package.json](../../../package.json)), **Node.js 24 LTS** con **ESM nativo** (`"type": "module"`, `module: "nodenext"`, `tsx` según [ADR-0006](../../../docs/adr/0006-estandarizacion-esm-prisma7-y-contratos-api.md)), **Zod 4** y las convenciones de [code-style.md](../../rules/code-style.md).
Prioridades: **Correctitud → Seguridad → Legibilidad → Simplicidad → Mantenibilidad → Rendimiento medido → Concisión**. *(Conciso = menos conceptos y ramas, no menos caracteres.)*

> [!NOTE]
> Todo código nuevo en `src/` debe compilar con `module: "nodenext"` (extensiones `.js` en imports relativos), `verbatimModuleSyntax` y `erasableSyntaxOnly` (sin `enum`, `namespace` con runtime ni *parameter properties*).

## 0. Modo de trabajo y reglas duras (MUST)

Antes de escribir o refactorizar, revisar [tsconfig.json](../../../tsconfig.json), el estilo del módulo y el tamaño esperado de colecciones (define estructura de datos y Big-O). Para colecciones que pueden crecer, declarar la complejidad en tiempo y memoria en una línea.

**Reglas duras:**
1. Cero `any`; `as` solo localizado y justificado (ej. constructor de *branded type* dentro de un schema Zod).
2. Solo sintaxis borrable (`erasableSyntaxOnly`): prohibido `enum` de TS, `namespace` con runtime y *parameter properties* (`constructor(public x: ...)`).
3. Todo input externo entra como `unknown` y se valida en el borde con `z.strictObject(...)` + `z.infer<typeof schema>`.
4. Estados inválidos imposibles de compilar: uniones discriminadas, *branded types* (`UserId`, `RecipeId`, `Email`) y `switch` con chequeo exhaustivo `assertNever(value)`.
5. Errores con jerarquía propia (`AppError` con `code` tipado y `cause` preservada); nunca `catch` vacío ni re-throw sin aporte; loguear una sola vez en el borde HTTP.
6. Sin `O(n²)` evitable en colecciones que crecen (`Map`/`Set`/`Map.groupBy` en vez de `find`/`includes`/`reduce` con spread o `shift()` en bucles).
7. Límites medidos: archivo ≤ 400 líneas (objetivo) / 1000 (duro); función ≤ 40 / 80; parámetros posicionales ≤ 3 / 4; profundidad ≤ 2 / 3; complejidad cognitiva ≤ 10 / 15.
8. Sin ciclos de imports; dependencias hacia el dominio; I/O con timeout/`AbortSignal`, concurrencia acotada y cero `forEach(async ...)` o promesas flotantes.

## 1. Tipos, OOP vs Funcional y principios

- **`type` vs `interface`:** `type` por defecto (uniones discriminadas, tuplas, funciones, `z.infer`, mapped/conditional types); `interface` cuando el contrato se extiende (`extends`) o lo implementa una clase (`RecipeRepository`, *module augmentation* de Express).
- **Constantes en vez de `enum`:** `export const RecipeStatus = { Draft: "DRAFT", Approved: "APPROVED" } as const;` + `type RecipeStatus = (typeof RecipeStatus)[keyof typeof RecipeStatus];`. Validar tablas literales con `as const satisfies Record<K, V>`.
- **Genéricos e inmutabilidad:** un genérico debe vincular al menos dos posiciones (usar `const` type parameters y `NoInfer<T>` cuando aporte); preferir `readonly`, `readonly T[]`, `toSorted`/`toReversed`/`with` y `structuredClone`.
- **Funciones vs Clases:** funciones puras y módulos para transformaciones, validación, mapeos DTO ↔ dominio y casos de uso sin estado con dependencias mínimas (`Pick<RecipeRepository, "findById">`); clases solo para invariantes encapsuladas con `#private` o recursos con ciclo de vida (`AppError`, pools, clientes). Nunca clases de puros `static`.
- **SOLID/KISS/DRY/YAGNI:** regla de tres antes de abstraer; sin `Factory`/`Strategy` para una sola implementación; dividir archivos grandes por responsabilidad (nunca por tamaño arbitrario).

## 2. Errores (`Result` vs `AppError`), Big-O y flujo conciso

- **Cuándo `Result<T, E>` vs `throw AppError`:** usar `Result<T, E>` (unión `{ ok: true; value } | { ok: false; error }`) para fallas esperables de reglas puras (`RN-04`/`RN-05`) o *hot paths*; `throw AppError` para fallas excepcionales/infraestructura; liberar recursos con `try/finally` (o `await using` si el runtime lo soporta).
- **Big-O y flujo:** usar `Map`/`Set` para lookups `O(1)`, `Map.groupBy` para agrupar, `some`/`find` en vez de `filter(...).length > 0`, iterator helpers lazy en colecciones grandes, *guard clauses* arriba y *dispatch maps* con `satisfies` en lugar de `if/else` repetitivos.
- **Asincronía:** `Promise.all` (todas requeridas), `Promise.allSettled` (parciales), `AbortSignal.any([reqSignal, AbortSignal.timeout(ms)])`, `p-limit` para concurrencia acotada.

## 3. Colaboración y delegación

| Necesidad | Skill |
|---|---|
| Capas (`src/modules/`), composition root, `.dependency-cruiser.cjs` y JSend | [layered-architecture-ts](../layered-architecture-ts/SKILL.md) |
| Cuánta abstracción construir, puertas 1/2 vías, triage de edge cases y tripwires | [pragmatic-engineering-complexity-control](../pragmatic-engineering-complexity-control/SKILL.md) |
| Runtime Node.js (event loop, libuv, streams, `AsyncLocalStorage`, `SIGTERM`) | [node-backend-engineering](../node-backend-engineering/SKILL.md) |
| Middlewares Express 5, `req.valid` y `errorHandlerMiddleware` | [express-backend-engineering](../express-backend-engineering/SKILL.md) |
| Semántica HTTP, BOPLA, paginación y resiliencia de API | [api-engineering-ts](../api-engineering-ts/SKILL.md) |
| Prisma 7, repositorios, `db-errors.ts` y transacciones `RN-06` | [orm-persistence-js-ts](../orm-persistence-js-ts/SKILL.md) |
| `package.json`, `env.ts`, `npm ci` y CI GitHub Actions | [js-project-configuration](../js-project-configuration/SKILL.md) |

Para `tsconfig` objetivo TS 7, branded types + `as const satisfies`, `AppError` borrable, `Result<T, E>` en `RN-04`/`RN-05`, reemplazos de `O(n²)`, `eslint.config.js` + `knip`, antipatrones y **Definition of Done**, consultá [references/ts-patterns.md](./references/ts-patterns.md).
