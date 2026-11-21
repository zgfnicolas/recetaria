# Modelo de datos

Fuente de verdad del esquema: [`prisma/schema.prisma`](../prisma/schema.prisma) (Prisma 7) y el esquema SQL inicial [`database_schema_init.sql`](../database_schema_init.sql) (motor PostgreSQL 15, normalización 3NF con columnas `JSONB` para ingredientes y metadatos nutricionales). Incluye 3 modelos activos (`User`, `Recipe`, `AuditLog`) y semillas iniciales de prueba para los 4 roles RBAC.

## Diagrama ER
```mermaid
erDiagram
  USERS ||--o{ RECIPES : "crea (authorId)"
  USERS ||--o{ RECIPES : "aprueba (reviewedById)"
  USERS ||--o{ AUDIT_LOGS : "genera (userId)"

  USERS {
    uuid id PK
    varchar email UK
    varchar passwordHash
    varchar firstName
    varchar lastName
    enum role
    boolean isActive
    timestamptz createdAt
    timestamptz updatedAt
  }

  RECIPES {
    uuid id PK
    varchar title
    varchar slug UK
    text description
    enum difficulty
    enum status
    smallint prepTimeMinutes
    varchar_array tags
    jsonb ingredients
    jsonb nutritionalInfo
    varchar coverImageUrl
    varchar videoUrl
    uuid authorId FK
    uuid reviewedById FK
    timestamptz publishedAt
    timestamptz createdAt
    timestamptz updatedAt
  }

  AUDIT_LOGS {
    uuid id PK
    varchar entityName
    uuid entityId
    varchar action
    uuid userId FK
    jsonb oldValues
    jsonb newValues
    timestamptz createdAt
  }
```

## Diccionario de datos

### Enumeraciones (`ENUM`)
- `Role`: `USER`, `CHEF`, `NUTRITIONIST`, `ADMIN`
- `RecipeStatus`: `DRAFT`, `APPROVED`
- `Difficulty`: `EASY`, `MEDIUM`, `HARD`, `EXPERT`

### Tabla `users`
Almacena identidades, credenciales cifradas y roles RBAC.

| Campo | Tipo | Nulo | Descripción |
|---|---|:-:|---|
| `id` | `UUID` | No | Identificador único (`PK`, `gen_random_uuid()`) |
| `email` | `VARCHAR(255)` | No | Correo único de acceso (`UNIQUE`) |
| `passwordHash` | `VARCHAR(255)` | No | Contraseña hasheada con Bcrypt |
| `firstName` | `VARCHAR(100)` | No | Nombre de pila |
| `lastName` | `VARCHAR(100)` | No | Apellido |
| `role` | `Role` | No | Rol RBAC, por defecto `'USER'` |
| `isActive` | `BOOLEAN` | No | Indicador de baja lógica, por defecto `TRUE` |
| `createdAt` | `TIMESTAMPTZ` | No | Fecha de creación (`NOW()`) |
| `updatedAt` | `TIMESTAMPTZ` | No | Última actualización (trigger automático) |

### Tabla `recipes`
Entidad principal con el contenido, metadatos nutricionales y estado de validación profesional.

| Campo | Tipo | Nulo | Descripción |
|---|---|:-:|---|
| `id` | `UUID` | No | Identificador único (`PK`, `gen_random_uuid()`) |
| `title` | `VARCHAR(150)` | No | Título de la receta |
| `slug` | `VARCHAR(200)` | No | Identificador legible autogenerado (`UNIQUE`) |
| `description` | `TEXT` | No | Descripción e instrucciones del plato |
| `difficulty` | `Difficulty` | No | Complejidad, por defecto `'MEDIUM'` |
| `status` | `RecipeStatus` | No | Estado de validación (`DRAFT` o `APPROVED`), por defecto `'DRAFT'` |
| `prepTimeMinutes` | `SMALLINT` | No | Tiempo en minutos (`CHECK ("prepTimeMinutes" > 0 AND "prepTimeMinutes" <= 1440)`) |
| `tags` | `VARCHAR(50)[]` | No | Etiquetas dietarias (máx. 20 ítems de ≤ 50 caracteres en Zod), por defecto `'{}'` |
| `ingredients` | `JSONB` | No | Lista estructurada de ingredientes (`name`, `quantity`, `unit`) |
| `nutritionalInfo` | `JSONB` | Sí | Objeto nutricional opcional tipado (`calories`, `proteinGrams`, `carbsGrams`, `fatGrams`, `fiberGrams`, `servings`) |
| `coverImageUrl` | `VARCHAR(512)` | Sí | URL de portada |
| `videoUrl` | `VARCHAR(512)` | Sí | URL de video corto |
| `authorId` | `UUID (FK)` | No | Autor que creó la receta (`-> users.id`) |
| `reviewedById` | `UUID (FK)` | Sí | Profesional que aprobó la receta (`-> users.id`) |
| `publishedAt` | `TIMESTAMPTZ` | Sí | Fecha y hora de aprobación |
| `createdAt` | `TIMESTAMPTZ` | No | Fecha de creación (`NOW()`) |
| `updatedAt` | `TIMESTAMPTZ` | No | Última actualización (trigger automático) |

### Tabla `audit_logs`
Registro inmutable de trazabilidad sobre cambios críticos (`APPROVE`, `RESET_TO_DRAFT`, `DELETE`).

| Campo | Tipo | Nulo | Descripción |
|---|---|:-:|---|
| `id` | `UUID` | No | Identificador del evento (`PK`) |
| `entityName` | `VARCHAR(50)` | No | Nombre canónico de la entidad afectada (`'Recipe'`) |
| `entityId` | `UUID` | No | ID del registro alterado (sin FK hacia `recipes` para conservar trazabilidad tras `DELETE`) |
| `action` | `VARCHAR(50)` | No | Acción ejecutada (`'APPROVE'`, `'RESET_TO_DRAFT'`, `'DELETE'`) |
| `userId` | `UUID (FK)` | Sí | Usuario que ejecutó la acción (`-> users.id`) |
| `oldValues` | `JSONB` | Sí | Snapshot previo al cambio |
| `newValues` | `JSONB` | Sí | Snapshot posterior al cambio |
| `createdAt` | `TIMESTAMPTZ` | No | Marca temporal del evento (`NOW()`) |

### Índices, triggers y datos semilla
- **Índices B-Tree:** `idx_users_role_isactive`, `idx_recipes_authorid`, `idx_recipes_status_difficulty`, `idx_audit_logs_entity`, `idx_audit_logs_createdat`, `idx_audit_logs_userid` (más los índices únicos implícitos de `UNIQUE(email)` y `UNIQUE(slug)`; los índices redundantes `idx_users_email` e `idx_recipes_slug` y `ON UPDATE CASCADE` se retiran en el saneamiento SQL de Fase 2 según `ADR-0006`).
- **Triggers:** `trg_users_updated_at` y `trg_recipes_updated_at` ejecutan `update_updated_at_column()` en `BEFORE UPDATE` para actualizar `"updatedAt" = NOW()`.
- **Seed inicial:** `database_schema_init.sql` inserta con `ON CONFLICT (email) DO NOTHING` 4 usuarios iniciales (`user@recetaria.com`, `chef@recetaria.com`, `nutri@recetaria.com`, `admin@recetaria.com`) para facilitar pruebas de roles.

## Políticas referenciales
| Relación | Restricción (FK) | `ON DELETE` | `ON UPDATE` | Motivo |
|---|---|---|---|---|
| `users → recipes (authorId)` | `fk_recipes_author` | `RESTRICT` | `NO ACTION` | Impide borrar físicamente un usuario si tiene recetas asociadas; obliga a preservar autoría |
| `users → recipes (reviewedById)` | `fk_recipes_reviewer` | `SET NULL` | `NO ACTION` | Preserva la receta si se da de baja el usuario revisor; el historial permanece en `audit_logs` |
| `users → audit_logs (userId)` | `fk_audit_logs_user` | `SET NULL` | `NO ACTION` | Garantiza la inmutabilidad del registro de auditoría aunque se elimine el usuario |
| `audit_logs.entityId` (sin FK a `recipes`) | `N/A` | `N/A` (conservado) | `N/A` | Permite ejecutar borrado físico en `DELETE /api/v1/recipes/:id` manteniendo íntegro el registro histórico del evento `DELETE` |

## Datos sensibles
| Campo | Clasificación | Tratamiento |
|---|---|---|
| `users.email` | Identificación personal | Acceso autenticado; nunca se expone en errores de login ni logs |
| `users.passwordHash` | Credencial crítica | Hash unidireccional Bcrypt (`saltRounds >= 10`); excluido de respuestas JSON |
| `recipes.nutritionalInfo` / `tags` | Salud implícita (Ley 25.326) | Validación estricta con Zod; aprobación restringida a perfiles `CHEF` / `NUTRITIONIST` |
