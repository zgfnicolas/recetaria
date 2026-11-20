---
name: docker-deploy
description: >-
  Opera los entornos Docker Compose (dev, db, debug, prod) y prepara el checklist de
  despliegue del backend. Usar solo cuando el usuario pida levantar contenedores, validar
  Docker o preparar un despliegue.
---

# Operación Docker y Despliegue

No ejecutes `docker compose up` ni despliegues productivos sin pedido explícito del usuario.

## 1. Comandos de Compose disponibles
```bash
npm run docker:config   # Valida sintaxis de compose.yaml + compose.override.yaml
npm run docker:db       # Levanta solo PostgreSQL 15 en segundo plano
npm run docker:dev      # Levanta API + PostgreSQL en desarrollo con hot-reload
npm run docker:debug    # Levanta PostgreSQL + Adminer (http://127.0.0.1:8080)
npm run docker:prod     # Levanta imagen endurecida de producción (compose.yaml)
npm run docker:down     # Detiene contenedores preservando postgres_data
```

## 2. Checklist previo a despliegue
1. `npx prisma validate` y `npm run build` sin errores.
2. `npm test` en verde.
3. `npm run docker:config` exitoso.
4. Confirmar que `.env.example` lista todas las variables (`NODE_ENV`, `PORT`, `POSTGRES_*`, `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`) sin valores reales.

Para el detalle técnico completo del Dockerfile multi-stage, hardening y checklist de 30 puntos, consultá [docker-architecture.md](./references/docker-architecture.md).

## 3. Skills relacionadas
- Diseño, endurecimiento de `Dockerfile`/`compose.yaml`, secretos `*_FILE`, CI/CD (Trivy/SBOM/Cosign) y verificación de producción: [docker-production-containers](../docker-production-containers/SKILL.md).
- Operación interna, roles, upgrades y backups/PITR de PostgreSQL: [postgresql-engineering](../postgresql-engineering/SKILL.md).
