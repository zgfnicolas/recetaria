# Recetaria API

API RESTful para publicar y consultar recetas gastronómicas validadas clínica y culinariamente por nutricionistas y chefs mediante control de acceso basado en roles (RBAC) y auditoría transaccional.

## Funcionalidades principales
- Registro y autenticación stateless con Bcrypt (`>= 10` rounds) y JSON Web Tokens (JWT)
- Gestión CRUD completa de recetas con validación estricta mediante Zod 4 (`z.strictObject`) y reglas de negocio explícitas en la capa de servicio (`RN-01`–`RN-08`)
- Filtrado (`status`, `difficulty`, `authorId`), paginación acotada (`page`, `limit`) y consulta privada de recetas propias (`GET /api/v1/recipes/mine`)
- Aprobación profesional exclusiva (`CHEF`, `NUTRITIONIST`) con bloqueo de auto-aprobación y auditoría atómica en `audit_logs` (`prisma.$transaction`)

## Stack
Backend: Node.js 24 LTS (ESM) + Express 5 + TypeScript 7 (`tsx`) · Base de datos: PostgreSQL 15 + Prisma 7 GA (`@prisma/adapter-pg`) · Validación y Seguridad: Zod 4 + Bcrypt + JWT + `dotenv` · Testing: Vitest + Supertest + Thunder Client · Contenedores: Docker Compose v2

## Inicio rápido

Requisitos previos: [Node.js 24 LTS](https://nodejs.org/) y [Docker Desktop](https://www.docker.com/products/docker-desktop/) con Compose v2.

```bash
git clone https://github.com/zgfnicolas/recetaria.git
cd recetaria
cp .env.example .env
# Completar .env con los valores locales indicados abajo
npm install
npm run db:generate
npm run docker:db
npx prisma migrate deploy
npm run dev
```

La API queda disponible en `http://localhost:3000` (alternativa 100 % contenerizada: `npm run docker:dev`).

### Variables de entorno locales (`.env`)
El archivo `.env.example` contiene únicamente los nombres de variables sin valores. Para desarrollo local, completá `.env` (ignorado en `.gitignore`) con valores de ejemplo como:

```env
NODE_ENV=development
PORT=3000
IMAGE_TAG=1.0.0
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=recetaria
POSTGRES_PORT=5432
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/recetaria?schema=public"
JWT_SECRET="reemplazar_por_secreto_criptografico_local_de_al_menos_64_caracteres"
JWT_EXPIRES_IN="1d"
```

## Catálogo de Endpoints

Todos los endpoints de negocio responden bajo el sobre **JSend extendido**:
- **Éxito (`200`, `201`):** `{ "success": true, "statusCode": 200, "message": "...", "data": { ... } }`
- **Error (`400`, `401`, `403`, `404`, `409`, `500`, `503`):** `{ "success": false, "statusCode": 400, "message": "...", "errors": [{ "field": "...", "message": "..." }] }`

| Método | Ruta | Acceso / Rol | Descripción | Códigos HTTP |
|---|---|---|---|---|
| `GET` | `/health` | Público | Liveness liviano del proceso (sin consulta a DB; usado por Docker `HEALTHCHECK`) | `200` |
| `GET` | `/health/ready` | Público | Readiness verificando conectividad a PostgreSQL (`SELECT 1`) | `200`, `503` |
| `POST` | `/api/v1/auth/register` | Público | Registra usuario con Bcrypt (`>= 10` rounds); acepta `role` opcional en MVP (`USER` por defecto) | `201`, `400`, `409` |
| `POST` | `/api/v1/auth/login` | Público | Autentica credenciales y devuelve Bearer JWT (`{ id, role }`); rechaza `isActive = false` | `200`, `400`, `401` |
| `GET` | `/api/v1/recipes` | Público | Lista recetas paginadas (`?status=&difficulty=&authorId=&page=1&limit=20`, máx. `100`) ordenadas por `createdAt DESC, id DESC` | `200`, `400` |
| `GET` | `/api/v1/recipes/mine` | Autenticado (JWT) | Lista paginada exclusivamente de las recetas creadas por el usuario autenticado (`authorId === req.user.id`) | `200`, `400`, `401` |
| `GET` | `/api/v1/recipes/:id` | Público | Obtiene el detalle de una receta por UUID | `200`, `400`, `404` |
| `POST` | `/api/v1/recipes` | Autenticado (JWT) | Crea una receta en estado `DRAFT` con `slug` automático y validaciones `RN-07` en servicio | `201`, `400`, `401`, `409` |
| `PUT` | `/api/v1/recipes/:id` | Autor (`RN-02`) | Actualiza parcial o totalmente la receta propia; si estaba `APPROVED`, reinicia a `DRAFT` con registro `RESET_TO_DRAFT` en `audit_logs` | `200`, `400`, `401`, `403`, `404`, `409` |
| `DELETE` | `/api/v1/recipes/:id` | Autor o `ADMIN` (`RN-03`) | Elimina físicamente la receta dentro de `$transaction` registrando `DELETE` con snapshot en `audit_logs` | `200`, `400`, `401`, `403`, `404` |
| `PUT` | `/api/v1/recipes/:id/approve` | `CHEF` o `NUTRITIONIST` ≠ Autor (`RN-04`, `RN-05`) | Aprueba receta `DRAFT → APPROVED` dentro de `$transaction` registrando `APPROVE` en `audit_logs` | `200`, `400`, `401`, `403`, `404`, `409` |

## Extras opcionales implementados
- **Filtros con `req.query`:** `GET /api/v1/recipes?status=APPROVED&difficulty=EASY&authorId=<uuid>&page=1&limit=20`.
- **Roles (RBAC):** 4 roles (`USER`, `CHEF`, `NUTRITIONIST`, `ADMIN`) — solo `CHEF`/`NUTRITIONIST` aprueban recetas de terceros (`RN-04`/`RN-05`), y solo Autor o `ADMIN` eliminan (`RN-03`).
- **Relación entre modelos:** `Recipe.authorId → User.id` (`ON DELETE RESTRICT`), `Recipe.reviewedById → User.id` (`ON DELETE SET NULL`), `AuditLog.userId → User.id`, con filtro `?authorId=` y endpoint dedicado `GET /api/v1/recipes/mine`.
- **Middleware de logging:** `loggerMiddleware` imprime en consola método, URL, código HTTP y duración de cada petición sin exponer headers sensibles.

## Pruebas (Vitest + Supertest + Thunder Client)
- **Automatizadas:** `npm test` ejecuta pruebas unitarias (`*.service.test.ts`, mockeando solo `Repository`) e integración con Supertest contra PostgreSQL Docker.
- **Thunder Client:** importar la colección exportada en `docs/thunder-client-collection.json` (cubre todos los endpoints y casos de error `400`, `401`, `403`, `404` y `409`).
- **Usuarios semilla (contraseña `password123`):** `user@recetaria.com`, `chef@recetaria.com`, `nutri@recetaria.com` y `admin@recetaria.com`.

## Scripts disponibles

| Script | Propósito |
| :--- | :--- |
| `npm run dev` | Inicia el servidor local en desarrollo con `tsx watch src/server.ts` |
| `npm run build` | Compila TypeScript a `dist/` verificando tipos |
| `npm run typecheck` | Valida tipos sin emitir archivos (`tsc --noEmit`) |
| `npm run typecheck:test` | Valida tipos en `src/`, `tests/`, `vitest.config.ts` y `prisma.config.ts` sin emitir archivos |
| `npm start` | Ejecuta el compilado en producción (`dist/server.js`) |
| `npm test` | Ejecuta la suite de pruebas con Vitest |
| `npm run db:validate` | Valida `prisma/schema.prisma` (no requiere `.env`) |
| `npm run db:format` | Formatea `prisma/schema.prisma` |
| `npm run db:generate` | Genera el cliente en `src/generated/prisma/` (ignorado en Git; corre automáticamente antes de `build`, `typecheck`, `typecheck:test` y `test`) |
| `npm run docker:db` | Levanta solo PostgreSQL 15 en segundo plano |
| `npm run docker:dev` | Levanta API y PostgreSQL en Docker con hot-reload (ejecutar antes `npm run db:generate` en el host) |
| `npm run docker:debug` | Levanta PostgreSQL y Adminer en `http://127.0.0.1:8080` |
| `npm run docker:prod` | Levanta la imagen endurecida de producción (`compose.yaml`) |
| `npm run docker:down` | Detiene y remueve los contenedores preservando los datos |

## Documentación
- [Requisitos del producto (PRD)](docs/prd.md)
- [Roles y permisos](docs/roles.md)
- [Reglas de negocio](docs/business_rules.md)
- [Arquitectura del sistema (SAD)](docs/sad.md)
- [Modelo de datos](docs/data_model.md)
- [Decisiones de arquitectura (ADR)](docs/adr/)
- [Roadmap del producto](docs/roadmap.md)
- [Estrategia de testing](docs/testing.md)
- [Privacidad y cumplimiento](docs/compliance.md)
- [Cómo contribuir](CONTRIBUTING.md)

## Estado
En desarrollo — versión 0.1.0 (MVP Backend)

## Licencia
MIT — ver [LICENSE](LICENSE)
