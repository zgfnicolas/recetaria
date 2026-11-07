---
description: Reglas y estándares de estilo de código para TypeScript y Node.js en Recetaria API
globs: ["src/**/*.ts", "*.ts"]
---

# Reglas de Estilo de Código (Code Style)

## 1. Tipado Estricto de TypeScript
- **Prohibido `any`:** Ninguna variable, parámetro o retorno puede ser de tipo `any`.
- **Inferencia de Zod:** Utilizar siempre `z.infer<typeof schema>` para definir tipos de DTOs y evitar discrepancias entre validación y tipos estáticos.
- **Tipado Explícito de Retorno:** Todas las funciones en Servicios y Repositorios deben declarar explícitamente su tipo de retorno (ej. `Promise<Recipe>`, `Promise<User | null>`).

## 2. Nomenclatura
- **Archivos:** `kebab-case` para código fuente (`recipe.service.ts`, `auth.controller.ts`, `user.repository.ts`).
- **Clases y Tipos/Interfaces:** `PascalCase` (`RecipeService`, `CreateRecipeDTO`, `IUserRepository`).
- **Funciones y Variables:** `camelCase` (`findById`, `recipeSlug`, `isValidPassword`).
- **Constantes Globales y Enums:** `UPPER_SNAKE_CASE` o `PascalCase` para miembros de Enums (`Role.CHEF`, `RecipeStatus.APPROVED`).

## 3. Manejo de Errores en Controladores
- Todo controlador debe envolver su ejecución en un bloque `try/catch`.
- El bloque `catch` debe capturar el error y delegar al formateador JSend o al middleware global de errores.
- Nunca silenciar excepciones ni imprimir trazas con credenciales en la consola.

## 4. Inmutabilidad y Clean Code
- Preferir `const` sobre `let`. Nunca utilizar `var`.
- Desestructuración limpia de objetos (`const { email, password } = req.body;`).
- Funciones cortas con una única responsabilidad.
