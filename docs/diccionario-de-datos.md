### Identificación del Proyecto

| Campo | Detalles |
| --- | --- |
| **Nombre del Proyecto** | Recetaria (Fase 1: MVP Backend API) |
| **Versión / Revisión** | 1.0.0 |
| **Fecha de Creación** | 06/11/2026 |
| **Estado** | Aprobado / En Implementación |
| **Responsable Técnico** | Facundo Nicolás González |
| **Fecha de Última Revisión** | 06/11/2026 |
| **Recursos** | `schema.prisma`, Trabajo práctico integrador |
| **Motor de BD** | PostgreSQL (v15+) |
| **Nivel de Normalización** | 3NF (Tercera Forma Normal) y campos JSONB desnormalizados para metadatos nutricionales. |

### 1. Diccionario de datos (Estructura de tablas)

**Tabla: `users**`
Descripción: Almacena las identidades, credenciales cifradas y roles de los usuarios del sistema (Públicos, Chefs, Nutricionistas y Admins).

| Campo | Tipo de Dato | Restricciones | Descripción | Ejemplo |
| --- | --- | --- | --- | --- |
| `id` | UUID | PK, NOT NULL | Identificador único del usuario. | `550e8400-e29b...` |
| `email` | VARCHAR(255) | UNIQUE, NOT NULL | Correo electrónico de acceso. | `usuario@email.com` |
| `passwordHash` | VARCHAR(255) | NOT NULL | Contraseña cifrada con Bcrypt. | `$2b$10$XyZ...` |
| `firstName` | VARCHAR(100) | NOT NULL | Nombre de pila. | `Facundo` |
| `lastName` | VARCHAR(100) | NOT NULL | Apellido. | `González` |
| `role` | ENUM("Role") | NOT NULL, DEFAULT 'USER' | Perfil de control de acceso (RBAC). | `CHEF` |
| `isActive` | BOOLEAN | NOT NULL, DEFAULT TRUE | Indicador de baja lógica del usuario. | `true` |
| `createdAt` | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Auditoría de creación. | `2026-11-06 12:00:00` |
| `updatedAt` | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Modificación (Trigger auto). | `2026-11-06 12:00:00` |

**Tabla: `recipes**`
Descripción: Entidad principal. Almacena el contenido, metadatos, estado de publicación y detalles de las recetas generadas por los usuarios.

| Campo | Tipo de Dato | Restricciones | Descripción | Ejemplo |
| --- | --- | --- | --- | --- |
| `id` | UUID | PK, NOT NULL | Identificador único de la receta. | `a1b2c3d4-e5f6...` |
| `title` | VARCHAR(150) | NOT NULL | Nombre de la receta. | `Tarta Sin TACC` |
| `slug` | VARCHAR(200) | UNIQUE, NOT NULL | URL amigable para SEO. | `tarta-sin-tacc` |
| `description` | TEXT | NOT NULL | Resumen del plato. | `Una tarta ideal para...` |
| `difficulty` | ENUM | NOT NULL, DEFAULT 'MEDIUM' | Nivel de complejidad. | `EASY` |
| `status` | ENUM | NOT NULL, DEFAULT 'DRAFT' | Estado de validación. | `APPROVED` |
| `prepTimeMinutes` | SMALLINT | NOT NULL, CHECK(>0) | Tiempo en minutos. | `45` |
| `tags` | VARCHAR(50)[] | NOT NULL, DEFAULT '{}' | Arreglo de etiquetas. | `{"vegano", "sin tacc"}` |
| `ingredients` | JSONB | NOT NULL | Cantidades y unidades estructuradas. | `[{"item": "Harina", "q": 500}]` |
| `nutritionalInfo` | JSONB | NULL | Macros validados por nutricionista. | `{"kcal": 350, "prot": 20}` |
| `coverImageUrl` | VARCHAR(512) | NULL | Enlace al bucket S3 (Fase 2). | `https://s3.../img.jpg` |
| `authorId` | UUID | FK, NOT NULL | Autor de la receta. | `550e8400-e29b...` |
| `reviewedById` | UUID | FK, NULL | Profesional que aprobó la receta. | `661f8400-a29b...` |

**Tabla: `sessions**`
Descripción: Gestiona los tokens de refresco y la huella de los dispositivos conectados para la seguridad del usuario.

| Campo | Tipo de Dato | Restricciones | Descripción | Ejemplo |
| --- | --- | --- | --- | --- |
| `id` | UUID | PK, NOT NULL | Identificador de la sesión. | `b1c2...` |
| `userId` | UUID | FK, NOT NULL | Usuario dueño de la sesión. | `550e8400-e29b...` |
| `refreshToken` | VARCHAR(512) | UNIQUE, NOT NULL | Token JWT de larga duración. | `eyJhbGci...` |
| `expiresAt` | TIMESTAMPTZ | NOT NULL | Fecha de caducidad del token. | `2026-11-20 12:00:00` |

**Tabla: `audit_logs**`
Descripción: Registro inmutable de eventos críticos (Aprobación/Rechazo de recetas) para asegurar la trazabilidad y la rendición de cuentas clínica/profesional.

| Campo | Tipo de Dato | Restricciones | Descripción | Ejemplo |
| --- | --- | --- | --- | --- |
| `id` | UUID | PK, NOT NULL | Identificador del log. | `f1a2...` |
| `entityName` | VARCHAR(50) | NOT NULL | Nombre de la tabla afectada. | `Recipe` |
| `entityId` | UUID | NOT NULL | ID del registro alterado. | `a1b2c3d4-e5f6...` |
| `action` | VARCHAR(50) | NOT NULL | Acción ejecutada (CRUD). | `APPROVE` |
| `userId` | UUID | FK, NULL | Quién ejecutó la acción. | `550e8400-e29b...` |
| `newValues` | JSONB | NULL | Snapshot del estado post-cambio. | `{"status": "APPROVED"}` |

### 2. Integridad referencial y relaciones

| Relación (Origen -> Destino) | Cardinalidad | ON DELETE | ON UPDATE | Justificación |
| --- | --- | --- | --- | --- |
| `recipes.authorId` -> `users.id` | N:1 | RESTRICT | CASCADE | Previene borrar un usuario si tiene recetas publicadas. Obliga a hacer *soft delete* en el autor para no romper la plataforma. |
| `recipes.reviewedById` -> `users.id` | N:1 | SET NULL | CASCADE | Si el profesional que auditó es eliminado, la receta pierde el ID del revisor pero no desaparece. Queda registro en `audit_logs`. |
| `sessions.userId` -> `users.id` | N:1 | CASCADE | CASCADE | Garantiza que si un usuario es borrado, todas sus sesiones activas se destruyan inmediatamente. |
| `audit_logs.userId` -> `users.id` | N:1 | SET NULL | CASCADE | Los logs de auditoría son inmutables. Si el autor del evento desaparece, el log sobrevive con el autor en NULL para trazabilidad legal/métrica. |

### 3. Estrategia de optimización e indexación

| Tabla | Nombre del Índice | Columnas | Tipo de Índice | Propósito |
| --- | --- | --- | --- | --- |
| `users` | `idx_users_email` | `email` | B-Tree (Unique) | Acelera la búsqueda del usuario durante el login de autenticación. |
| `users` | `idx_users_role_isactive` | `role`, `isActive` | B-Tree | Optimiza la carga de listados de profesionales en el panel de administración. |
| `recipes` | `idx_recipes_slug` | `slug` | B-Tree (Unique) | Acelera la obtención del detalle de la receta desde URLs SEO-friendly. |
| `recipes` | `idx_recipes_status_diff` | `status`, `difficulty` | B-Tree Compuesto | Optimiza los filtros de búsqueda GET requeridos por el TP (ej. `?status=APPROVED&difficulty=EASY`). |

### 4. Lógica programable (Objetos de BD)

**Triggers (Disparadores)**

* **Nombre:** `trg_recipes_updated_at` / `trg_users_updated_at`
* **Evento:** `BEFORE UPDATE`
* **Lógica:** Dispara la función `update_updated_at_column()` cada vez que un registro sufre un `UPDATE`, garantizando que la columna `updatedAt` refleje la marca de tiempo exacta del motor de base de datos de forma automática, sin depender de la capa de Node.js.

**Procedimientos y Funciones**

| Nombre | Parámetros | Lógica Interna | Valor de Negocio |
| --- | --- | --- | --- |
| `update_updated_at_column` | `Ninguno` (Contexto Trigger) | Intercepta el registro `NEW` e inyecta `NOW()` en la columna `updatedAt` antes de persistir. | Asegura la veracidad de la trazabilidad temporal. |

*(Nota: En esta arquitectura, la lógica compleja de negocio, como la validación de roles en la aprobación de recetas, se delega a Prisma Client dentro de transacciones ACID `$transaction` en la capa de `Service` de Node.js, siguiendo el patrón de la API REST).*

### 5. Modelo de Seguridad (RBAC)

Dado que Prisma ORM se conecta a PostgreSQL usando un único usuario de servicio, el Principio de Menor Privilegio se aplica en la creación de ese rol.

| Rol Sugerido | Perímetro de Acción | Permisos (Grants) | Justificación |
| --- | --- | --- | --- |
| `api_service_role` | Esquema transaccional (Node.js API) | `SELECT`, `INSERT`, `UPDATE`, `DELETE` en todas las tablas transaccionales. | Operaciones base para el CRUD y Prisma Client. Prohibido ejecutar sentencias `DROP` o `ALTER TABLE` fuera de los scripts de migración. |
| `migration_role` | Infraestructura | `ALL PRIVILEGES` en el esquema. | Utilizado exclusivamente durante despliegues de CI/CD al ejecutar `npx prisma migrate deploy`. |

### 6. Referencias de Modelado

* **Diagrama ERD:** Contenido en el modelo declarativo `prisma/schema.prisma`.
* **Manual de Normas de Nomenclatura:** Se utilizará `camelCase` para los nombres de las columnas a nivel de Prisma Client, los cuales son mapeados directamente a la base de datos para mantener consistencia con los estándares de TypeScript/JavaScript en el entorno Node.js, y `PascalCase` para los nombres de los Modelos (Tablas).