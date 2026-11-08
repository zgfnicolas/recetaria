# Configuración de Entornos de Despliegue (Deploy Config)

## 1. Variables de Entorno Requeridas

| Variable | Descripción | Ejemplo / Formato |
| :--- | :--- | :--- |
| `NODE_ENV` | Entorno de ejecución (`development`, `test`, `production`). | `production` |
| `PORT` | Puerto de escucha HTTP del servidor Express. | `3000` |
| `DATABASE_URL` | Cadena de conexión PostgreSQL con connection pooling. | `postgresql://user:pass@host:5432/recetaria?schema=public` |
| `JWT_SECRET` | Semilla criptográfica para la firma de tokens JWT. | Cadena aleatoria de 64+ caracteres |
| `JWT_EXPIRES_IN` | Tiempo de expiración del token JWT de acceso. | `1d` o `7d` |

---

## 2. Entornos de Despliegue Soportados

### 2.1. Docker Compose (Local / Staging / Producción)
El proyecto utiliza la especificación Compose moderna (sin cabecera `version: '3.8'` obsoleta) bajo el estándar `SKL-DEVOPS-DKR-001`:

- **Producción / Staging:** `compose.yaml` (artefacto inmutable, `read_only: true`, `cap_drop: [ALL]`, aislamiento en redes `application` y `data` interna, healthchecks integrados con `condition: service_healthy` y cuotas de CPU/memoria).
  - Comando: `npm run docker:prod` (equivalente a `docker compose -f compose.yaml up --build -d`)
- **Desarrollo Local:** `compose.yaml` fusionado automáticamente con `compose.override.yaml` (target `development`, hot-reload con bind mounts `:ro`, puertos aislados en loopback `127.0.0.1` y perfil opcional `debug` con Adminer).
  - Comando: `npm run docker:dev` (equivalente a `docker compose up --build`)
  - Solo Base de Datos: `npm run docker:db` (equivalente a `docker compose up -d postgres`)
  - Visor SQL (Adminer): `npm run docker:debug` (equivalente a `docker compose --profile debug up -d`)

Para la especificación técnica completa y checklist de 30 puntos, consultar `.ai/skills/docker_ops.md`.

### 2.2. Plataformas PaaS (Render / Railway)
- **Build Command:** `npm install && npx prisma generate && npm run build`
- **Pre-Deploy Command:** `npx prisma migrate deploy`
- **Start Command:** `npm start` (o `node dist/index.js`)
- **Health Check Endpoint:** `GET /health` o `GET /api/v1/recipes`
