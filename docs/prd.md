# PRD — Recetaria API
Versión 1.4 · Última actualización: 2026-11-24 · Responsable: Facundo Nicolás González

## 1. Visión
Centralizar un catálogo confiable de recetas gastronómicas donde el contenido generado por la comunidad es validado clínica y culinariamente por nutricionistas y chefs profesionales.

## 2. Problema
Los usuarios con necesidades alimentarias específicas (celiaquía, diabetes, dietas deportivas) sufren desinformación nutricional al buscar recetas en plataformas genéricas. Al mismo tiempo, los profesionales de la salud y la gastronomía carecen de un espacio estructurado para auditar contenido y respaldarlo con trazabilidad.

## 3. Público objetivo
- **Usuario principal (`USER`):** personas registradas que publican, buscan y filtran recetas adaptadas a sus tiempos y restricciones dietarias.
- **Revisor profesional (`CHEF` / `NUTRITIONIST`):** profesionales que aportan recetas verificadas y auditan recetas de terceros.
- **Administrador (`ADMIN`):** operador interno encargado de la moderación de catálogo.
- **Visitante (`Guest`):** persona sin sesión iniciada que consulta recetas mediante los endpoints públicos.

## 4. Propuesta de valor
Recetaria combina contenido generado por usuarios (UGC) con un flujo formal de aprobación profesional basado en roles (RBAC) y auditoría transaccional en base de datos, evitando la desinformación nutricional y garantizando integridad en cada cambio de estado.

## 5. Alcance
### Incluido en la versión 1 (MVP)
- **Base arquitectónica:** Node.js 24 LTS, ESM nativo (`nodenext`), Express 5, TypeScript 7 estricto (`tsx` en desarrollo) y PostgreSQL 15 + Prisma 7 GA (`@prisma/adapter-pg`) organizados por componentes (`auth`, `recipes`) en 4 capas (`Router -> Controller -> Service -> Repository`), con `src/app.ts` separado de `src/server.ts`.
- **Modelos activos (3):** `User`, `Recipe` y `AuditLog` (autenticación 100 % stateless sin tabla `sessions`).
- **Seguridad e identidad:** registro (`POST /api/v1/auth/register`, que crea siempre `USER` y rechaza `role` con `400`, ADR-0007) y login (`POST /api/v1/auth/login`) con Bcrypt (`>= 10` rounds), rechazo `401` si `isActive === false` y Bearer JWT (`{ id, role }`), más usuarios semilla (*seed*) para los 4 roles.
- **CRUD de recetas:** alta (`POST /api/v1/recipes`), lectura pública paginada (`GET /api/v1/recipes` con `?page=&limit=`, `GET /api/v1/recipes/:id`), consulta autenticada de recetas propias (`GET /api/v1/recipes/mine`), edición parcial o completa por el autor (`PUT /api/v1/recipes/:id`) y borrado físico por el autor o `ADMIN` (`DELETE /api/v1/recipes/:id`).
- **Validaciones:** Zod 4 estricto (`z.strictObject`) en middleware para formato/tipos/prevención BOPLA (incluyendo `tags` acotado y `nutritionalInfo` tipado) y validaciones explícitas de negocio en `RecipeService` (`prepTimeMinutes` entre `1` y `1440`, ingredientes con `quantity > 0`, ownership, bloqueo de auto-aprobación y detección de receta ya aprobada).
- **Aprobación profesional:** transición `DRAFT -> APPROVED` en `PUT /api/v1/recipes/:id/approve` exclusiva de `CHEF`/`NUTRITIONIST` con registro en `audit_logs` (`entityName = "Recipe"`) dentro de `prisma.$transaction`.
- **Extras del TP integrados:** filtros con `req.query` (`?status=`, `?difficulty=`, `?authorId=`, `?page=`, `?limit=`), control de roles RBAC, relación `User`–`Recipe` (`authorId`, `reviewedById`) y middleware de logging HTTP en consola (`loggerMiddleware`).
- **Operación y entrega:** endpoints `GET /health` (liveness liviano sin DB para Docker `HEALTHCHECK`) y `GET /health/ready` (readiness verificando PostgreSQL), respuestas en formato JSend extendido (`200`, `201`, `400`, `401`, `403`, `404`, `409`, `500`, `503`) y colección exportada en `docs/thunder-client-collection.json`.

### Fuera de alcance
- Funcionalidades sociales secundarias (likes, comentarios, seguidores y perfiles extendidos).
- Subida física de archivos multimedia a object storage (AWS S3) y verificación KYC documental de matrículas profesionales.
- Generador automático de planes alimenticios semanales (`MealPlans`) y listas de compras.
- Gestión persistente de refresh tokens (`sessions`) o estados intermedios (`PENDING_REVIEW`, `REJECTED`, `ARCHIVED`).
- Interfaz frontend web o aplicación móvil nativa.

## 6. Historias de usuario
| ID | Como... | Quiero... | Para... | Prioridad |
|---|---|---|---|---|
| HU-01 | visitante | registrarme con email, nombre, apellido y contraseña | crear una cuenta con credenciales seguras | Alta |
| HU-02 | usuario registrado | iniciar sesión con email y contraseña | obtener un token JWT válido y operar rutas protegidas | Alta |
| HU-03 | usuario autenticado | crear una receta con ingredientes y tiempo de preparación | compartirla en estado `DRAFT` con `slug` automático | Alta |
| HU-04 | visitante o usuario | listar, ver detalle y filtrar recetas por estado, dificultad o autor | encontrar platos acordes a mis necesidades | Alta |
| HU-05 | autor de una receta | editar parcial o totalmente mi propia receta | corregir datos sin conservar aprobaciones previas obsoletas | Alta |
| HU-06 | autor o administrador | eliminar físicamente una receta | retirar contenido propio o moderar el catálogo con auditoría | Media |
| HU-07 | chef o nutricionista | aprobar una receta en `DRAFT` de otro autor | publicarla como `APPROVED` con registro de auditoría | Alta |

### Criterios de aceptación

**HU-01 — Registro de usuario**
- Dado un payload válido con email no registrado y contraseña de al menos 8 caracteres, cuando se envía `POST /api/v1/auth/register`, entonces se crea un usuario con rol `USER` asignado por el servidor, la contraseña se almacena hasheada con Bcrypt (`>= 10` rounds) y retorna HTTP `201 Created`.
- Dado un payload que incluye `role` (con cualquier valor, incluido `USER`), cuando se envía `POST /api/v1/auth/register`, entonces retorna HTTP `400 Bad Request` ("Campo no permitido") y no se crea el usuario (BFLA/mass assignment, #48).
- Dado un email ya registrado, cuando se envía `POST /api/v1/auth/register`, entonces retorna HTTP `409 Conflict`.

**HU-02 — Inicio de sesión**
- Dado un email y contraseña válidos de un usuario con `isActive === true`, cuando se envía `POST /api/v1/auth/login`, entonces retorna HTTP `200 OK` con un JWT firmado (`{ id, role }`).
- Dada una contraseña incorrecta, un email inexistente o un usuario inactivo (`isActive === false`), cuando se envía `POST /api/v1/auth/login`, entonces retorna HTTP `401 Unauthorized` genérico.

**HU-03 — Creación de receta**
- Dado un token JWT válido y un payload estricto (`z.strictObject`) con `prepTimeMinutes` entre `1` y `1440`, ingredientes válidos (`quantity > 0`), `tags` (≤ 20 ítems, ≤ 50 caracteres) y `nutritionalInfo` opcional tipado, cuando se envía `POST /api/v1/recipes`, entonces `RecipeService` genera el `slug` automáticamente (`<titulo-ascii>-<8-hex>`, ≤ 200 caracteres), guarda la receta en estado `DRAFT` asociada a `req.user.id` y retorna HTTP `201 Created`.

**HU-04 — Listado, detalle y filtrado de recetas**
- Dado un cliente HTTP sin o con token consultando `GET /api/v1/recipes`, cuando no envía filtros, entonces retorna HTTP `200 OK` con `data: { items, meta: { page, limit, total, totalPages } }` ordenado por `createdAt DESC, id DESC` (por defecto `page=1`, `limit=20`, máximo `100`) incluyendo `DRAFT` y `APPROVED`; si envía `?status=APPROVED&difficulty=EASY&authorId=<uuid>&page=1&limit=20`, aplica los filtros y paginación combinados.
- Dado un usuario autenticado consultando `GET /api/v1/recipes/mine`, entonces retorna HTTP `200 OK` con el mismo formato paginado filtrando exclusivamente por `authorId === req.user.id` (sin token retorna `401 Unauthorized`).
- Dado un parámetro `:id` sin formato UUIDv4 en `GET /api/v1/recipes/:id`, entonces Zod retorna `400 Bad Request`; si el UUID es válido pero no existe, retorna `404 Not Found`.

**HU-05 — Edición de receta propia**
- Dado un usuario autenticado distinto de `recipe.authorId`, cuando envía `PUT /api/v1/recipes/:id`, entonces el sistema retorna HTTP `403 Forbidden`.
- Dado el autor original enviando al menos 1 campo válido en `PUT /api/v1/recipes/:id`, si la receta estaba `APPROVED`, entonces dentro de `prisma.$transaction` actualiza los campos, reinicia `status` a `DRAFT`, limpia `reviewedById` y `publishedAt`, e inserta `RESET_TO_DRAFT` (`entityName = "Recipe"`) en `audit_logs` (regenerando `slug` si cambió `title`). Si la receta ya estaba `DRAFT`, actualiza normalmente sin escribir en `audit_logs`. Si envía `{}` vacío o campos no permitidos, retorna `400 Bad Request`.

**HU-06 — Eliminación física de receta**
- Dado el autor original (`authorId`) o un `ADMIN`, cuando envía `DELETE /api/v1/recipes/:id` sobre un ID existente, entonces dentro de `prisma.$transaction` inserta en `audit_logs` el evento `DELETE` con `oldValues` y elimina la fila de `recipes`, retornando `200 OK`. Un usuario no autorizado recibe `403 Forbidden` y un ID inexistente `404 Not Found`.

**HU-07 — Aprobación profesional**
- Dado un `USER`, `ADMIN` o el propio autor de la receta intentando ejecutar `PUT /api/v1/recipes/:id/approve`, entonces recibe HTTP `403 Forbidden`.
- Dado un `CHEF` o `NUTRITIONIST` distinto del autor sobre una receta ya `APPROVED`, entonces recibe HTTP `409 Conflict`.
- Dado un `CHEF` o `NUTRITIONIST` distinto del autor sobre una receta en `DRAFT`, entonces dentro de `prisma.$transaction` cambia el estado a `APPROVED`, registra `reviewedById` y `publishedAt`, e inserta el evento `APPROVE` en `audit_logs`.

## 7. Requisitos no funcionales
| ID | Categoría | Requisito |
|---|---|---|
| RNF-01 | Rendimiento | El 95 % (P95) de las consultas de lectura (`GET /api/v1/recipes`) responden en menos de 150 ms apoyadas en índices B-Tree. |
| RNF-02 | Seguridad | Contraseñas con Bcrypt (`>= 10` rounds), autenticación JWT stateless, control RBAC estricto y secretos aislados en `.env` (`.gitignore`). |
| RNF-03 | Fiabilidad | Transacciones compuestas en `prisma.$transaction` ACID; el 100 % de los controladores usa `try/catch` devolviendo formato JSend sin filtrar stack traces. |
| RNF-04 | Mantenibilidad | Arquitectura modular en 4 capas (`Router -> Controller -> Service -> Repository`), TypeScript estricto sin `any` y validación Zod previa al controlador. |

## 8. Métricas de éxito
- 100 % de los endpoints del MVP cubiertos por pruebas automatizadas y colección exportada en `docs/thunder-client-collection.json` (`200`, `201`, `400`, `401`, `403`, `404`, `409`).
- 100 % de las transiciones críticas (`APPROVE`, `RESET_TO_DRAFT`, `DELETE`) registradas en `audit_logs`.
- 0 errores de compilación TypeScript (`npm run build`) y 0 llamadas directas a Prisma desde `Service` o `Controller`.

## 9. Supuestos y riesgos
- **Alcance congelado para el MVP:** se diferen funcionalidades sociales, subida a S3, KYC documental y `sessions` persistentes para respetar la entrega de 2 semanas sin deuda de estados huérfanos.
- **Alta de roles para evaluación:** el registro público crea siempre `USER` (ADR-0007, #48). Los roles privilegiados se obtienen **solo** con [`prisma/seed.ts`](../prisma/seed.ts) (`npx prisma db seed` / `npm run db:seed`, únicamente con `NODE_ENV=development|test`), que siembra de forma idempotente los 4 usuarios base (`user`, `chef`, `nutri`, `admin`) para probar todos los flujos en Thunder Client. En una fase productiva futura, el alta de roles privilegiados pasará por un endpoint de administración auditado o por KYC.
- **Filtros sobre JSONB:** las búsquedas iniciales indexan columnas escalares (`status`, `difficulty`, `authorId`); el parseo avanzado dentro de `ingredients` queda para fases posteriores.
