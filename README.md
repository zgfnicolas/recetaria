# Recetaria API

API RESTful para publicar y consultar recetas gastronómicas validadas clínicamente y culinariamente por nutricionistas y chefs mediante control de acceso basado en roles (RBAC).

## Funcionalidades principales
- Registro y autenticación stateless con Bcrypt y JSON Web Tokens (JWT)
- Gestión CRUD de recetas con validación estricta mediante esquemas Zod
- Búsqueda y filtrado de recetas por estado y dificultad
- Aprobación profesional exclusiva (`CHEF`, `NUTRITIONIST`) con auditoría transaccional (`audit_logs`)

## Stack
Backend: Node.js 22 + Express 5 + TypeScript · Base de datos: PostgreSQL 15 + Prisma ORM · Validación y Seguridad: Zod + Bcrypt + JWT · Contenedores: Docker Compose v2

## Inicio rápido

Requisitos previos: [Node.js 22+](https://nodejs.org/) y [Docker Desktop](https://www.docker.com/products/docker-desktop/) con Compose v2.

```bash
git clone https://github.com/zgfnicolas/recetaria.git
cd recetaria
cp .env.example .env
npm install
npm run docker:db
npm run dev
```

La API queda disponible en `http://localhost:3000` (alternativa 100% contenerizada: `npm run docker:dev`).

## Scripts disponibles

| Script | Propósito |
| :--- | :--- |
| `npm run dev` | Inicia el servidor local en desarrollo con hot-reload |
| `npm run build` | Compila TypeScript a `dist/` verificando tipos |
| `npm start` | Ejecuta el compilado en producción (`dist/index.js`) |
| `npm test` | Ejecuta la suite de pruebas |
| `npm run docker:db` | Levanta solo PostgreSQL 15 en segundo plano |
| `npm run docker:dev` | Levanta API y PostgreSQL en Docker con hot-reload |
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
