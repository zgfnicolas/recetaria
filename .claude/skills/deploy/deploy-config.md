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

### 2.1. Docker Compose (Local / Staging)
```yaml
version: '3.8'
services:
  api:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgresql://postgres:postgres@db:5432/recetaria
    depends_on:
      - db
  db:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: recetaria
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
```

### 2.2. Plataformas PaaS (Render / Railway)
- **Build Command:** `npm install && npx prisma generate && npm run build`
- **Pre-Deploy Command:** `npx prisma migrate deploy`
- **Start Command:** `npm start` (o `node dist/index.js`)
- **Health Check Endpoint:** `GET /health` o `GET /api/v1/recipes`
