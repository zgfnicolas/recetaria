# PRD — Recetaria API
Versión 1.1 · Última actualización: 2026-11-17 · Responsable: Facundo Nicolás González

## 1. Visión
Centralizar un catálogo confiable de recetas gastronómicas donde el contenido generado por la comunidad es validado clínica y culinariamente por nutricionistas y chefs profesionales.

## 2. Problema
Los usuarios con necesidades alimentarias específicas (celiaquía, diabetes, dietas deportivas) sufren desinformación nutricional al buscar recetas en plataformas genéricas. Al mismo tiempo, los profesionales de la salud y la gastronomía carecen de un espacio estructurado para auditar contenido y respaldarlo con trazabilidad.

## 3. Público objetivo
- **Usuario principal (USER):** personas registradas que publican, buscan y filtran recetas adaptadas a sus tiempos y restricciones dietarias.
- **Usuario validador (CHEF / NUTRITIONIST):** profesionales que aportan recetas verificadas y auditan recetas de terceros.
- **Usuario administrador (ADMIN):** personal interno encargado del gobierno de la plataforma y moderación general.
- **Usuario público (Guest):** visitantes sin sesión que exploran recetas aprobadas.

## 4. Propuesta de valor
Recetaria combina contenido generado por usuarios (UGC) con un flujo formal de aprobación profesional basado en roles (RBAC) y auditoría transaccional en base de datos, evitando la desinformación nutricional y garantizando integridad en cada cambio de estado.

## 5. Alcance
### Incluido en la versión 1 (MVP)
- Registro e inicio de sesión mediante Bcrypt y JSON Web Tokens (JWT) stateless.
- CRUD completo de recetas (`POST`, `GET`, `PUT`, `DELETE`) con validación de esquemas Zod.
- Búsqueda y filtrado de recetas mediante query params (`status`, `difficulty`).
- Flujo de aprobación profesional (`PUT /api/v1/recipes/:id/approve`) restringido a `CHEF` y `NUTRITIONIST` con registro en `audit_logs`.
- Contratos HTTP estandarizados bajo formato JSend.

### Fuera de alcance
- Funcionalidades sociales secundarias (likes, comentarios, seguidores y perfiles extendidos).
- Subida física de archivos multimedia a object storage (AWS S3) y verificación KYC automatizada de matrículas profesionales.
- Generador automático de planes alimenticios semanales (`MealPlans`) y listas de compras.
- Interfaz frontend web o aplicación móvil nativa.

## 6. Historias de usuario
| ID | Como... | Quiero... | Para... | Prioridad |
|---|---|---|---|---|
| HU-01 | usuario no autenticado | registrarme con email, nombre, apellido y contraseña | crear una cuenta segura en la plataforma | Alta |
| HU-02 | usuario registrado | iniciar sesión con email y contraseña | obtener un JWT válido y operar rutas protegidas | Alta |
| HU-03 | usuario autenticado | crear una receta con ingredientes y tiempo de preparación | compartirla en estado borrador (`DRAFT`) | Alta |
| HU-04 | visitante o usuario | listar y filtrar recetas por estado o dificultad | encontrar platos acordes a mis necesidades | Alta |
| HU-05 | autor de una receta | editar los datos de mi propia receta | corregir ingredientes o descripción sin afectar terceros | Alta |
| HU-06 | autor o administrador | eliminar una receta | retirar contenido propio o moderar la plataforma | Media |
| HU-07 | chef o nutricionista | aprobar una receta pendiente de revisión | publicarla como confiable con registro de auditoría | Alta |

### Criterios de aceptación

**HU-01 — Registro de usuario**
- Dado un payload válido con email no registrado y contraseña de al menos 8 caracteres, cuando se envía `POST /api/v1/auth/register`, entonces la contraseña se almacena hasheada con Bcrypt, se crea el usuario con rol por defecto `USER` y se retorna HTTP `201 Created`.
- Dado un email ya existente en la base de datos, cuando se envía `POST /api/v1/auth/register`, entonces el sistema retorna HTTP `409 Conflict`.

**HU-02 — Inicio de sesión**
- Dado un email y contraseña válidos, cuando se envía `POST /api/v1/auth/login`, entonces se retorna HTTP `200 OK` con un token JWT firmado (`{ id, role }`).
- Dada una contraseña incorrecta o email inexistente, cuando se envía `POST /api/v1/auth/login`, entonces se retorna HTTP `401 Unauthorized` sin revelar cuál campo falló.

**HU-03 — Creación de receta**
- Dado un usuario autenticado con JWT válido y payload validado por Zod (`prepTimeMinutes > 0`, al menos un ingrediente), cuando envía `POST /api/v1/recipes`, entonces la receta se persiste en estado `DRAFT` con `authorId` igual al ID del token y retorna HTTP `201 Created`.

**HU-04 — Listado y filtrado de recetas**
- Dado un cliente HTTP consultando `GET /api/v1/recipes?status=APPROVED&difficulty=EASY`, cuando los parámetros cumplen el esquema Zod, entonces se devuelve HTTP `200 OK` con el listado coincidente en formato JSend.
- Dado un parámetro inválido en `GET /api/v1/recipes/:id` (UUID mal formado), cuando Zod valida `req.params`, entonces responde HTTP `400 Bad Request`.

**HU-05 — Edición de receta propia**
- Dado un usuario autenticado que no es el `authorId` de la receta, cuando envía `PUT /api/v1/recipes/:id`, entonces el sistema rechaza la operación con HTTP `403 Forbidden`.

**HU-06 — Eliminación de receta**
- Dado un usuario que es el `authorId` o posee rol `ADMIN`, cuando envía `DELETE /api/v1/recipes/:id` sobre un ID existente, entonces retorna HTTP `200 OK`; si el ID no existe, retorna HTTP `404 Not Found`.

**HU-07 — Aprobación profesional**
- Dado un usuario con rol `USER` intentando ejecutar `PUT /api/v1/recipes/:id/approve`, entonces el middleware RBAC responde HTTP `403 Forbidden`.
- Dado un usuario `CHEF` o `NUTRITIONIST` distinto del autor de la receta, cuando aprueba una receta revisable, entonces en una transacción atómica cambia el estado a `APPROVED`, registra `reviewedById` y `publishedAt`, e inserta el evento en `audit_logs`.

## 7. Requisitos no funcionales
| ID | Categoría | Requisito |
|---|---|---|
| RNF-01 | Rendimiento | El 95 % (P95) de las consultas de lectura (`GET /api/v1/recipes`) responden en menos de 150 ms. |
| RNF-02 | Seguridad | Contraseñas con hash Bcrypt (`saltRounds >= 10`), autenticación stateless JWT Bearer, control RBAC estricto y secretos fuera del repositorio (`.env`). |
| RNF-03 | Fiabilidad | Mutaciones compuestas ejecutadas en `prisma.$transaction` ACID; el 100 % de los controladores usa `try/catch` devolviendo formato JSend sin filtrar stack traces. |
| RNF-04 | Mantenibilidad | Arquitectura monolítica modular en 4 capas (`Router -> Controller -> Service -> Repository`), TypeScript estricto sin `any` y validación Zod previa al controlador. |

## 8. Métricas de éxito
- 100 % de los endpoints del MVP cubiertos por pruebas de integración y colección exportada de Thunder Client (casos `200`, `201`, `400`, `401`, `403`, `404`, `409`).
- 100 % de las aprobaciones de recetas registradas en `audit_logs`.
- 0 errores de compilación TypeScript (`npm run build`) y 0 llamadas directas a Prisma desde la capa de servicios.

## 9. Supuestos, riesgos y preguntas abiertas
- **Riesgo de alcance (Scope Creep):** incorporar funcionalidades sociales antes de cerrar el MVP. *Mitigación:* congelar el alcance v1 a `User`, `Recipe`, `Session` y `AuditLog`.
- **Complejidad de filtros en JSONB:** las búsquedas iniciales se limitan a columnas indexadas (`status`, `difficulty`); el análisis avanzado de `ingredients` y `nutritionalInfo` queda para fases posteriores.
- **Pregunta abierta:** ¿Los profesionales (`CHEF`, `NUTRITIONIST`) requieren verificación previa por parte de `ADMIN` en v1 o se habilita el alta en `/auth/register` para pruebas académicas?
