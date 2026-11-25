# Patrones de Ingeniería TypeScript para Recetaria API

Referencia ejecutable de [typescript-engineering](../SKILL.md) alineada a **TypeScript 7**, **Node.js 22+ LTS**, **Express 5**, **Zod 4** y las reglas de dominio (`RN-01`–`RN-10`) de Recetaria API.

---

## 1. Baseline `tsconfig.json` (TS 7 + ESM `nodenext`, `ADR-0006`)

Configuración objetivo para [tsconfig.json](../../../../tsconfig.json) con Node 24 LTS, ESM nativo y `tsx`:

```jsonc
{
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "target": "es2024",
    "lib": ["es2024"],
    "types": ["node"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noUncheckedIndexedAccess": true,        // arr[i] y record[k] => T | undefined
    "exactOptionalPropertyTypes": true,      // x?: T no admite undefined explícito
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,            // obliga a usar `import type` para tipos
    "erasableSyntaxOnly": true,              // prohíbe enum, namespace con runtime y parameter properties
    "isolatedModules": true,
    "skipLibCheck": true,
    "sourceMap": true
  }
}
```

- Con Node ejecutando `.ts` directamente (*type stripping*), usar imports con extensión `.ts`, `subpath imports` (`#src/*`) en lugar de `paths`, y `tsc --noEmit` en CI.

---

## 2. Sistema de tipos fuerte sobre el dominio de Recetaria

### 2.1 Constantes borrables (`as const` + `satisfies`) en lugar de `enum`
```ts
export const RecipeStatus = {
  Draft: "DRAFT",
  Approved: "APPROVED",
} as const;
export type RecipeStatus = (typeof RecipeStatus)[keyof typeof RecipeStatus];

export const Role = {
  User: "USER",
  Chef: "CHEF",
  Nutritionist: "NUTRITIONIST",
  Admin: "ADMIN",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const CAN_APPROVE_BY_ROLE = {
  USER: false,
  CHEF: true,
  NUTRITIONIST: true,
  ADMIN: false, // RN-04: solo CHEF o NUTRITIONIST aprueban recetas
} as const satisfies Record<Role, boolean>;
```

### 2.2 Branded types validados en el borde con Zod 4
```ts
import { z } from "zod";

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Brand<string, "UserId">;
export type RecipeId = Brand<string, "RecipeId">;
export type Email = Brand<string, "Email">;

export const UserIdSchema = z.uuid().transform((v) => v as UserId);
export const RecipeIdSchema = z.uuid().transform((v) => v as RecipeId);
export const EmailSchema = z.email().trim().toLowerCase().transform((v) => v as Email);
// Pasar un UserId donde se espera un RecipeId falla en compilación.
```

### 2.3 Unión discriminada, `assertNever` y `assertDefined`
```ts
export type RecipeLifecycle =
  | { readonly status: "DRAFT"; readonly id: RecipeId }
  | { readonly status: "APPROVED"; readonly id: RecipeId; readonly reviewedById: UserId; readonly publishedAt: Date };

export function assertNever(value: never, message = "Caso no contemplado"): never {
  throw new UnreachableError(`${message}: ${JSON.stringify(value)}`);
}

export function assertDefined<T>(value: T | null | undefined, what: string): asserts value is T {
  if (value == null) throw new InvariantError(`${what} es requerido`);
}

export function describeLifecycle(state: RecipeLifecycle): string {
  switch (state.status) {
    case "DRAFT":
      return "Borrador";
    case "APPROVED":
      return `Aprobada por ${state.reviewedById}`;
    default:
      return assertNever(state);
  }
}
```

---

## 3. Errores borrables (`AppError`) y `Result<T, E>`

```ts
// src/shared/errors/app-error.ts (sin parameter properties => 100 % compatible con erasableSyntaxOnly)
export type ErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "DEPENDENCY_FAILED"
  | "TIMEOUT"
  | "INVARIANT_VIOLATION"
  | "UNREACHABLE";

export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Record<string, unknown> = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.details = details;
  }
}

export class ValidationError extends AppError { readonly code = "VALIDATION_FAILED"; }
export class ForbiddenError extends AppError { readonly code = "FORBIDDEN"; }
export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND";
  constructor(resource: string, id: string) { super(`${resource} no encontrado`, { resource, id }); }
}
export class ConflictError extends AppError { readonly code = "CONFLICT"; }
export class InvariantError extends AppError { readonly code = "INVARIANT_VIOLATION"; }
export class UnreachableError extends AppError { readonly code = "UNREACHABLE"; }

export const HTTP_STATUS_BY_CODE = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DEPENDENCY_FAILED: 502,
  TIMEOUT: 504,
  INVARIANT_VIOLATION: 500,
  UNREACHABLE: 500,
} as const satisfies Record<ErrorCode, number>;
```

### `Result<T, E>` mínimo para reglas puras de negocio (`RN-04` / `RN-05`)
```ts
// src/shared/result.ts
export type Result<T, E = AppError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

// Regla pura sin mocks ni DB (guard clauses + unión de error)
type ApproveRejection = "ROLE_NOT_ALLOWED" | "SELF_APPROVAL_FORBIDDEN" | "ALREADY_APPROVED";

export function canApproveRecipe(
  recipe: { readonly status: RecipeStatus; readonly authorId: UserId },
  actor: { readonly id: UserId; readonly role: Role },
): Result<true, ApproveRejection> {
  if (!CAN_APPROVE_BY_ROLE[actor.role]) return err("ROLE_NOT_ALLOWED");     // RN-04
  if (recipe.authorId === actor.id) return err("SELF_APPROVAL_FORBIDDEN");  // RN-05
  if (recipe.status === RecipeStatus.Approved) return err("ALREADY_APPROVED");
  return ok(true);
}
```

---

## 4. OOP vs Funcional y principios SOLID/KISS/DRY/YAGNI

- **Funcional (default en servicios y reglas puras):** inyectar dependencias mínimas con `Pick<>` (ISP) y evitar importar Prisma en la capa de negocio:
  ```ts
  type ApproveRecipeDeps = Readonly<{
    recipes: Pick<RecipeRepository, "findById" | "approveWithAudit">;
  }>;
  ```
- **OOP (cuando hay invariantes con estado o recursos con ciclo de vida):** usar campos `#private` reales en runtime y constructores sin *parameter properties*.

| Principio | Aplicación concreta en Recetaria | Señal de violación |
|---|---|---|
| **SRP** | Un archivo cambia por un solo motivo/capa | Un servicio parseando `req.body` y llamando a Prisma |
| **OCP** | Agregar un rol o código de error actualiza un `Record` con `satisfies` | `if/else` sobre `role` repetido en 5 archivos |
| **LSP** | Fakes de repositorio respetan los mismos retornos/errores que el real | `instanceof` para bifurcar lógica |
| **ISP** | Recibir `Pick<RecipeRepository, "findById">` en vez de todo el objeto | Funciones que solo usan 1 método de un objeto gigante |
| **DIP** | `service.ts` depende de la interfaz del repositorio, no de `PrismaClient` | `import { prisma }` dentro de `*.service.ts` |
| **DRY / KISS / YAGNI** | Regla de tres antes de abstraer; nada "por si acaso" | `Factory`/`BaseRepository<T>` con una sola implementación |

---

## 5. Complejidad Big-O, estructuras de datos y control de flujo

| Operación | `Array` | `Set` | `Map` |
|---|---|---|---|
| Pertenencia (`includes`/`has`) | `O(n)` | `O(1)` | `O(1)` por clave |
| Búsqueda por clave (`find`/`get`) | `O(n)` | — | `O(1)` |
| Quitar al inicio (`shift`) | `O(n)` | — | — |
| Orden (`toSorted`) | `O(n log n)` | — | — |
| Diferencia/intersección | `O(n·m)` | `O(n + m)` (`a.difference(b)`) | — |

```ts
// ✗ O(n·m): búsqueda lineal dentro de map
// const enriched = recipes.map((r) => ({ ...r, author: users.find((u) => u.id === r.authorId) }));

// ✓ O(n + m): índice previo en Map
const usersById = new Map(users.map((u) => [u.id, u]));
const enriched = recipes.map((r) => ({ ...r, author: usersById.get(r.authorId) }));

// ✓ O(n): agrupar sin reduce con spread ({ ...acc, [k]: v } es O(n²))
const recipesByStatus = Map.groupBy(recipes, (r) => r.status);

// ✓ O(n + m): filtrar contra lista de tags usando Set
const allowedTagSet = new Set(allowedTags);
const validTags = recipe.tags.filter((tag) => allowedTagSet.has(tag));

// ✓ Cortocircuito: some/find en vez de filter(...).length > 0
const hasInvalidIngredient = ingredients.some((item) => item.quantity <= 0);
```

- Para colecciones grandes: usar *iterator helpers* lazy (`items.values().filter(...).take(10).toArray()`) o procesamiento por lotes (`for await`) manteniendo memoria `O(lote)`.

---

## 6. Concurrencia acotada, bordes y tooling de calidad (CI)

```ts
// Paralelismo cancelable con timeout compuesto
const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(2_000)]);
const [recipe, author] = await Promise.all([findRecipe(id, signal), findAuthor(authorId, signal)]);

// Borde Zod 4: rechaza campos extra (prevención BOPLA)
export const createRecipeBodySchema = z.strictObject({
  title: z.string().trim().min(3).max(150),
  prepTimeMinutes: z.number().int().min(1).max(1440),
});
export type CreateRecipeBody = z.infer<typeof createRecipeBodySchema>;
```

### Reglas de ESLint (`typescript-eslint` + `sonarjs`) y `knip`
```js
// eslint.config.js (extracto objetivo al incorporar linter en CI)
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";

export default tseslint.config(
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    plugins: { sonarjs },
    rules: {
      "max-lines": ["error", { max: 1000, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["warn", { max: 80, skipBlankLines: true, skipComments: true }],
      "max-params": ["error", 4],
      "max-depth": ["error", 3],
      "sonarjs/cognitive-complexity": ["error", 15],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/only-throw-error": "error",
    },
  },
);
```

- Complementar en CI con `knip` (código muerto y exports sin uso) y `.dependency-cruiser.cjs` (cero ciclos y respeto de capas, ver [layered-architecture-ts](../../layered-architecture-ts/SKILL.md)).

---

## 7. Antipatrones y Definition of Done

**Antipatrones:** `any` o `as` sobre JSON externo · `enum`/`namespace` con runtime · *parameter properties* · `switch` sin `assertNever` · `reduce` con spread del acumulador · `find`/`includes` dentro de bucles · `shift()` en colas · `filter().length > 0` · `JSON.parse(JSON.stringify())` para clonar · archivos > 1000 líneas o funciones > 80 líneas · > 3 niveles de anidamiento · booleanos posicionales (`fn(true, false)`) · clases con solo `static` · barrels globales que introducen ciclos · `catch` vacío o que pierde `cause` · loguear el mismo error en cada capa · `forEach(async ...)` · promesas flotantes · `console.log` en producción.

**Definition of Done:** compila en modo estricto (`npm run build`) sin `any` y con sintaxis borrable · inputs externos validados con `z.strictObject` y DTOs vía `z.infer` · estados modelados con uniones discriminadas + `assertNever` y tablas con `satisfies` · `AppError` borrable con `cause` preservada y `Result` en reglas puras · sin `O(n²)` evitable en colecciones crecientes · async con `AbortSignal`, timeouts y concurrencia acotada · archivo ≤ 1000 líneas, función ≤ 80, complejidad cognitiva ≤ 15, profundidad ≤ 3, parámetros ≤ 4 · cero ciclos y tests en verde.
