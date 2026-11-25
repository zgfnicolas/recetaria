# Roadmap

## Ahora — v0.x (MVP Académico)
Objetivo: entregar una API REST funcional para `Auth` y `Recipes` con arquitectura en 4 capas, Docker reproducible y pruebas verificadas.
- Esquema de base de datos en PostgreSQL 15 y Prisma 7 GA (`users`, `recipes`, `audit_logs`)
- Registro y login con Bcrypt y JWT sin sesiones; autorización con el estado vigente del usuario (ADR-0009)
- CRUD completo de recetas con filtros (`status`, `difficulty`, `authorId`) y paginación acotada (`page`, `limit`)
- Aprobación profesional exclusiva (`CHEF`, `NUTRITIONIST`) con auditoría transaccional (`audit_logs`)
- Colección de Thunder Client y suite de pruebas unitarias/integración

**Criterio de salida:** 100 % de los endpoints del MVP cubriendo códigos `200`, `201`, `400`, `401`, `403`, `404` y `409`, `npm run build` sin errores ni `any` implícitos, y ejecución exitosa en Docker Compose.

**Seguimiento en vivo:** [GitHub Project — Recetaria MVP TP Integrador](https://github.com/users/zgfnicolas/projects/3) · [Milestone `v0.1.0 — MVP TP Integrador`](https://github.com/zgfnicolas/recetaria/milestone/1) *(fuente única de verdad para las Specs `#1`–`#6` y Tickets `#7`–`#24`)*

## Próximo — v1.0 (Alfa y Beta)
Objetivo: incorporar interacción comunitaria (UGC) y verificación documental de profesionales.
- **Módulo Social (Alfa):** likes, comentarios y sistema de seguidores entre usuarios
- **Multimedia (Alfa):** carga de imágenes y videos cortos mediante URLs pre-firmadas en object storage (AWS S3)
- **CI/CD (Alfa):** pipelines automatizados de lint, tests y build en GitHub Actions
- **KYC Profesional (Beta):** flujo de validación de matrículas para otorgar roles `CHEF` y `NUTRITIONIST` por `ADMIN`
- **Planificación Dietaria (Beta):** entidades de planes semanales (`MealPlans`) y análisis de macros en `JSONB`

**Criterio de salida:** cobertura de pruebas de integración > 80 % en módulos nuevos y pipeline de CI en verde en cada PR.

## Más adelante — v2.0 (Escala Empresarial)
Objetivo: soportar alto tráfico de lectura y búsqueda avanzada.
- Capa de caché en memoria (Redis) para listados públicos de recetas
- Réplicas de lectura (*Read Replicas*) en PostgreSQL si la carga de consultas lo requiere
- Feed personalizado según restricciones dietarias y profesionales seguidos
- Optimización SEO (slugs, sitemaps dinámicos y microdatos)

**Criterio de salida:** latencia P95 < 100 ms bajo pruebas de carga con K6.
