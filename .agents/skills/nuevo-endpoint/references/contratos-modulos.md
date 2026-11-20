# Contratos Base de Módulos (Auth y Recipes)

Referencia de contratos y firmas para los módulos iniciales bajo `src/modules/`, alineada con `ADR-0006` (Zod 4 `z.strictObject`, orden `authMiddleware → rbacMiddleware → validateMiddleware`, paginación acotada y `entityName = "Recipe"`).

## 1. Módulo Auth (`src/modules/auth/`)

### Router (`auth.router.ts`)
- `POST /api/v1/auth/register` -> `validateMiddleware({ body: registerSchema })` -> `authController.register`
- `POST /api/v1/auth/login` -> `validateMiddleware({ body: loginSchema })` -> `authController.login`

### Esquemas Zod 4 (`auth.schema.ts`)
```typescript
import { z } from "zod";

export const registerSchema = z.strictObject({
  email: z.email("Formato de email inválido").trim().toLowerCase(),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres"),
  firstName: z.string().trim().min(2, "El nombre debe tener al menos 2 caracteres").max(100),
  lastName: z.string().trim().min(2, "El apellido debe tener al menos 2 caracteres").max(100),
  role: z.enum(["USER", "CHEF", "NUTRITIONIST", "ADMIN"]).optional().default("USER"),
});

export const loginSchema = z.strictObject({
  email: z.email("Formato de email inválido").trim().toLowerCase(),
  password: z.string().min(1, "La contraseña es obligatoria"),
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
- **Invariantes (`RN-08`):** `register` retorna `409` si el email existe y aplica `bcrypt.hash(password, 10)`; `login` rechaza credenciales inválidas o usuarios con `isActive === false` con el mismo `401 Unauthorized` genérico (comparación timing-safe contra hash ficticio cuando no existe el email).

---

## 2. Módulo Recipes (`src/modules/recipes/`)

### Router (`recipe.router.ts`)
*(Orden en rutas protegidas: **`authMiddleware → rbacMiddleware → validateMiddleware`**.)*
- `GET /api/v1/recipes` -> `validateMiddleware({ query: recipeQuerySchema })` -> `recipeController.getAll`
- `GET /api/v1/recipes/mine` -> `authMiddleware` -> `validateMiddleware({ query: recipeQuerySchema })` -> `recipeController.getMine` *(registrar **antes** de `/:id`)*
- `GET /api/v1/recipes/:id` -> `validateMiddleware({ params: uuidParamSchema })` -> `recipeController.getById`
- `POST /api/v1/recipes` -> `authMiddleware` -> `validateMiddleware({ body: createRecipeSchema })` -> `recipeController.create`
- `PUT /api/v1/recipes/:id` -> `authMiddleware` -> `validateMiddleware({ params: uuidParamSchema, body: updateRecipeSchema })` -> `recipeController.update`
- `DELETE /api/v1/recipes/:id` -> `authMiddleware` -> `validateMiddleware({ params: uuidParamSchema })` -> `recipeController.delete`
- `PUT /api/v1/recipes/:id/approve` -> `authMiddleware` -> `rbacMiddleware(["CHEF", "NUTRITIONIST"])` -> `validateMiddleware({ params: uuidParamSchema })` -> `recipeController.approve`

### Esquemas Zod 4 (`recipe.schema.ts`)
```typescript
import { z } from "zod";

export const uuidParamSchema = z.strictObject({
  id: z.uuid("El parámetro id debe ser un UUID válido"),
});

export const ingredientItemSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  quantity: z.number(),
  unit: z.string().trim().min(1).max(30),
});

export const nutritionalInfoSchema = z.strictObject({
  calories: z.number().nonnegative().optional(),
  proteinGrams: z.number().nonnegative().optional(),
  carbsGrams: z.number().nonnegative().optional(),
  fatGrams: z.number().nonnegative().optional(),
  fiberGrams: z.number().nonnegative().optional(),
  servings: z.number().int().positive().optional(),
});

export const createRecipeSchema = z.strictObject({
  title: z.string().trim().min(3).max(150),
  description: z.string().trim().min(10),
  difficulty: z.enum(["EASY", "MEDIUM", "HARD", "EXPERT"]).default("MEDIUM"),
  prepTimeMinutes: z.number().int(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  ingredients: z.array(ingredientItemSchema).min(1, "Debe incluir al menos un ingrediente"),
  nutritionalInfo: nutritionalInfoSchema.optional(),
  coverImageUrl: z.url().max(512).optional(),
  videoUrl: z.url().max(512).optional(),
});

export const updateRecipeSchema = createRecipeSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: "Debe enviar al menos un campo para actualizar",
  });

export const recipeQuerySchema = z.strictObject({
  status: z.enum(["DRAFT", "APPROVED"]).optional(),
  difficulty: z.enum(["EASY", "MEDIUM", "HARD", "EXPERT"]).optional(),
  authorId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateRecipeDTO = z.infer<typeof createRecipeSchema>;
export type UpdateRecipeDTO = z.infer<typeof updateRecipeSchema>;
export type RecipeQueryDTO = z.infer<typeof recipeQuerySchema>;

export type PaginatedRecipes = Readonly<{
  items: Recipe[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}>;
```
*(Nota: la validación de negocio `prepTimeMinutes` entre `1` y `1440` y `quantity > 0` en cada ingrediente se verifica explícitamente en `RecipeService` según `RN-07`.)*

### Servicio (`recipe.service.ts`) y Repositorio (`recipe.repository.ts`)
```typescript
export interface IRecipeService {
  getAll(filters: RecipeQueryDTO): Promise<PaginatedRecipes>;
  getMine(authorId: string, filters: Omit<RecipeQueryDTO, "authorId">): Promise<PaginatedRecipes>;
  getById(id: string): Promise<Recipe>;
  create(authorId: string, dto: CreateRecipeDTO): Promise<Recipe>;
  update(recipeId: string, userId: string, dto: UpdateRecipeDTO): Promise<Recipe>;
  delete(recipeId: string, userId: string, userRole: string): Promise<void>;
  approve(recipeId: string, reviewerId: string): Promise<Recipe>;
}

export interface IRecipeRepository {
  findManyPaginated(filters: RecipeQueryDTO): Promise<PaginatedRecipes>;
  findById(id: string): Promise<Recipe | null>;
  findBySlug(slug: string): Promise<Recipe | null>;
  create(data: Prisma.RecipeCreateInput): Promise<Recipe>;
  updateWithOptionalReset(
    id: string,
    data: Prisma.RecipeUpdateInput,
    auditPayload?: { userId: string; oldValues: Prisma.InputJsonValue; newValues: Prisma.InputJsonValue },
  ): Promise<Recipe>;
  deleteWithAudit(
    id: string,
    auditPayload: { userId: string; oldValues: Prisma.InputJsonValue },
  ): Promise<void>;
  approveWithAudit(
    recipeId: string,
    reviewerId: string,
    previousSnapshot: Prisma.InputJsonValue,
  ): Promise<Recipe | null>;
}
```
- **Invariantes (`docs/business_rules.md`):**
  - `getAll`: orden determinístico `("createdAt" DESC, id DESC)`, defaults `page=1`, `limit=20`, máx `100`.
  - `create`: valida `RN-07`, autogenera `slug` `<titulo-ascii>-<8-hex>` (≤ 200 chars), inicia en `DRAFT` (`RN-01`).
  - `update`: verifica ownership (`RN-02`), valida `RN-07` sobre campos presentes, regenera `slug` si cambia `title`; si estaba `APPROVED`, reinicia a `DRAFT` limpiando `reviewedById` y `publishedAt` e inserta `RESET_TO_DRAFT` (`entityName = "Recipe"`) en `audit_logs` dentro de `$transaction`; si ya estaba `DRAFT`, no inserta en `audit_logs`.
  - `delete`: verifica `authorId === userId || userRole === "ADMIN"` (`RN-03`) y ejecuta `deleteWithAudit` (`entityName = "Recipe"`) dentro de `$transaction`.
  - `approve`: bloquea auto-aprobación (`RN-05`, `403`), rechaza si ya estaba `APPROVED` (`RN-04`, `409`), y ejecuta `approveWithAudit` (`entityName = "Recipe"`) dentro de `$transaction` (`RN-06`).
