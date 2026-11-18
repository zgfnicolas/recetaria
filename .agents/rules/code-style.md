---
trigger: glob
globs: "src/**/*.ts, *.ts"
description: "Estándares de TypeScript estricto, nomenclatura y manejo de errores en controladores."
---

# Estándares de Código TypeScript

## 1. Tipado Estricto
- Prohibido `any` explícito o implícito.
- Inferir todos los DTOs desde esquemas Zod (`export type CreateRecipeDTO = z.infer<typeof createRecipeSchema>;`).
- Declarar explícitamente tipos de parámetros y retorno en todos los métodos de `Service` y `Repository`.

## 2. Separación de Capas y Controladores
- `Controller` solo lee `req.body`, `req.query`, `req.params` y `req.user`, delega en `Service` y envuelve cada método en `try/catch`.
- `Service` nunca importa ni instancia `PrismaClient`; invoca únicamente métodos de `Repository`.
- Mantener funciones cortas, con una responsabilidad única y retornos tempranos.

## 3. Nomenclatura
- Archivos: `kebab-case.ts` (ej. `recipe.service.ts`, `auth.controller.ts`, `validate.middleware.ts`).
- Clases, interfaces y tipos: `PascalCase` (`RecipeService`, `IUserRepository`, `CreateRecipeDTO`).
- Funciones y variables: `camelCase` (`findBySlug`, `prepTimeMinutes`).
- Preferir `const` sobre `let`; nunca usar `var`.
