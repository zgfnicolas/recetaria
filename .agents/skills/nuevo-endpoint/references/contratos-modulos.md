# Contratos Base de Módulos (Auth y Recipes)

Referencia de contratos y firmas para los módulos iniciales bajo `src/modules/`.

## 1. Módulo Auth (`src/modules/auth/`)

### Router (`auth.router.ts`)
- `POST /api/v1/auth/register` -> `validate(registerSchema)` -> `authController.register`
- `POST /api/v1/auth/login` -> `validate(loginSchema)` -> `authController.login`

### Esquemas Zod (`auth.schema.ts`)
```typescript
import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email('Formato de email inválido'),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
  firstName: z.string().min(2, 'El nombre debe tener al menos 2 caracteres'),
  lastName: z.string().min(2, 'El apellido debe tener al menos 2 caracteres'),
  role: z.enum(['USER', 'CHEF', 'NUTRITIONIST']).optional().default('USER')
});

export const loginSchema = z.object({
  email: z.string().email('Formato de email inválido'),
  password: z.string().min(1, 'La contraseña es obligatoria')
});

export type RegisterDTO = z.infer<typeof registerSchema>;
export type LoginDTO = z.infer<typeof loginSchema>;
```

### Servicio (`auth.service.ts`) y Repositorio (`user.repository.ts`)
```typescript
export interface IAuthService {
  register(dto: RegisterDTO): Promise<{ id: string; email: string; role: string }>;
  login(dto: LoginDTO): Promise<{ token: string; user: { id: string; email: string; role: string } }>;
}

export interface IUserRepository {
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  create(data: Prisma.UserCreateInput): Promise<User>;
}
```
- **Invariantes:** `register` retorna `409` si el email existe y aplica `bcrypt.hash(password, 10)` (`RN-08`); `login` retorna `401` genérico si fallan las credenciales.

---

## 2. Módulo Recipes (`src/modules/recipes/`)

### Router (`recipe.router.ts`)
- `GET /api/v1/recipes` -> `validateQuery(recipeQuerySchema)` -> `recipeController.getAll`
- `GET /api/v1/recipes/:id` -> `validateParams(uuidParamSchema)` -> `recipeController.getById`
- `POST /api/v1/recipes` -> `authMiddleware` -> `validate(createRecipeSchema)` -> `recipeController.create`
- `PUT /api/v1/recipes/:id` -> `authMiddleware` -> `validate(updateRecipeSchema)` -> `recipeController.update`
- `DELETE /api/v1/recipes/:id` -> `authMiddleware` -> `recipeController.delete`
- `PUT /api/v1/recipes/:id/approve` -> `authMiddleware` -> `rbacMiddleware(['CHEF', 'NUTRITIONIST'])` -> `recipeController.approve`

### Esquemas Zod (`recipe.schema.ts`)
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
  nutritionalInfo: z.record(z.string(), z.unknown()).optional(),
  coverImageUrl: z.string().url().optional()
});

export const recipeQuerySchema = z.object({
  status: z.enum(['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'ARCHIVED']).optional(),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD', 'EXPERT']).optional()
});

export type CreateRecipeDTO = z.infer<typeof createRecipeSchema>;
export type RecipeQueryDTO = z.infer<typeof recipeQuerySchema>;
```

### Servicio (`recipe.service.ts`) y Repositorio (`recipe.repository.ts`)
```typescript
export interface IRecipeService {
  getAll(filters: RecipeQueryDTO): Promise<Recipe[]>;
  getById(id: string): Promise<Recipe>;
  create(authorId: string, dto: CreateRecipeDTO): Promise<Recipe>;
  update(recipeId: string, userId: string, dto: Partial<CreateRecipeDTO>): Promise<Recipe>;
  delete(recipeId: string, userId: string, userRole: string): Promise<void>;
  approve(recipeId: string, reviewerId: string): Promise<Recipe>;
}

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
- **Invariantes:** ver `RN-01` a `RN-07` en `docs/business_rules.md`. `approveWithAudit` ejecuta actualización y registro en `audit_logs` dentro de `prisma.$transaction`.
