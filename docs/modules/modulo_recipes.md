# Especificación Técnica de Módulo: Recipes (`modulo_recipes`)

| Metadata | Valor |
| :--- | :--- |
| **Identificador** | `MOD-REC-001` |
| **Ubicación en Código** | `src/modules/recipes/` |
| **Estándar** | SKL-PRO-001 (Nivel 3: Especificación en `/doc/modules/`) |
| **Versión** | 1.0.0 |

---

## 1. Responsabilidad del Módulo

Gestionar el CRUD completo de recetas, filtrado por query params (`status`, `difficulty`), control de autoría sobre modificaciones, y el flujo transaccional de aprobación profesional por parte de perfiles médicos o gastronómicos (`CHEF`, `NUTRITIONIST`).

---

## 2. Contratos y Firmas de la Capa

### 2.1. Router (`recipe.router.ts`)
- `GET /api/v1/recipes` -> `validateQuery(recipeQuerySchema)` -> `recipeController.getAll`
- `GET /api/v1/recipes/:id` -> `validateParams(uuidParamSchema)` -> `recipeController.getById`
- `POST /api/v1/recipes` -> `authMiddleware` -> `validate(createRecipeSchema)` -> `recipeController.create`
- `PUT /api/v1/recipes/:id` -> `authMiddleware` -> `validate(updateRecipeSchema)` -> `recipeController.update`
- `DELETE /api/v1/recipes/:id` -> `authMiddleware` -> `recipeController.delete`
- `PUT /api/v1/recipes/:id/approve` -> `authMiddleware` -> `rbacMiddleware(['CHEF', 'NUTRITIONIST'])` -> `recipeController.approve`

### 2.2. Esquemas de Validación Zod (`recipe.schema.ts`)
```typescript
import { z } from 'zod';

export const ingredientItemSchema = z.object({
  name: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.string().min(1)
});

export const createRecipeSchema = z.object({
  title: z.string().min(3).max(150),
  description: z.string().min(10),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD', 'EXPERT']).default('MEDIUM'),
  prepTimeMinutes: z.number().int().positive('El tiempo debe ser mayor a 0'),
  tags: z.array(z.string()).default([]),
  ingredients: z.array(ingredientItemSchema).min(1, 'Debe incluir al menos un ingrediente'),
  nutritionalInfo: z.record(z.any()).optional(),
  coverImageUrl: z.string().url().optional()
});

export const recipeQuerySchema = z.object({
  status: z.enum(['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'ARCHIVED']).optional(),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD', 'EXPERT']).optional()
});

export type CreateRecipeDTO = z.infer<typeof createRecipeSchema>;
export type RecipeQueryDTO = z.infer<typeof recipeQuerySchema>;
```

### 2.3. Servicio (`recipe.service.ts`)
```typescript
export interface IRecipeService {
  getAll(filters: RecipeQueryDTO): Promise<Recipe[]>;
  getById(id: string): Promise<Recipe>;
  create(authorId: string, dto: CreateRecipeDTO): Promise<Recipe>;
  update(recipeId: string, userId: string, dto: Partial<CreateRecipeDTO>): Promise<Recipe>;
  delete(recipeId: string, userId: string, userRole: string): Promise<void>;
  approve(recipeId: string, reviewerId: string): Promise<Recipe>;
}
```

### 2.4. Repositorio (`recipe.repository.ts`)
```typescript
export interface IRecipeRepository {
  findMany(filters: RecipeQueryDTO): Promise<Recipe[]>;
  findById(id: string): Promise<Recipe | null>;
  findBySlug(slug: string): Promise<Recipe | null>;
  create(data: Prisma.RecipeCreateInput): Promise<Recipe>;
  update(id: string, data: Prisma.RecipeUpdateInput): Promise<Recipe>;
  delete(id: string): Promise<Recipe>;
  approveWithAudit(recipeId: string, reviewerId: string): Promise<Recipe>;
}
```
*(Nota: `approveWithAudit` ejecuta la transacción `$transaction` atómica para actualizar la receta e insertar en `audit_logs`).*
