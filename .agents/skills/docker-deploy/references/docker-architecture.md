# Arquitectura Docker de Recetaria API

Resumen técnico de los artefactos de contenerización en la raíz (`Dockerfile`, `compose.yaml`, `compose.override.yaml`, `.dockerignore`).

## 1. Dockerfile Multi-Stage (5 etapas)
Base fijada: `node:22.14.0-bookworm-slim` (compatibilidad `glibc` para Prisma y compilación nativa de `bcrypt`).

1. **`base`**: imagen Node 22 slim con `WORKDIR /app`.
2. **`deps`**: instala dependencias deterministas con `npm ci` usando BuildKit cache mount (`/root/.npm`) y ejecuta `prisma generate`.
3. **`development`**: target local con `ts-node-dev` bajo `USER node`.
4. **`build`**: compila TypeScript (`npm run build`) y poda dependencias de desarrollo (`npm prune --omit=dev`).
5. **`runtime` (`production`)**: copia únicamente `dist/` y `node_modules/` productivos, corre como `USER node` (`uid=1000`), usa `HEALTHCHECK` nativo con `node -e "fetch(...)"` (sin `curl`) y `CMD ["node", "dist/index.js"]` en formato exec para manejar `SIGTERM`.

## 2. Composición (`compose.yaml` y `compose.override.yaml`)
- **Producción (`compose.yaml`):**
  - `read_only: true` con `/tmp` en `tmpfs`.
  - `cap_drop: [ALL]` y `security_opt: [no-new-privileges:true]`.
  - Redes segmentadas: `application` (bridge) y `data` (`internal: true` para aislar PostgreSQL).
  - Orquestación por salud: `depends_on: postgres: condition: service_healthy` (`pg_isready`).
  - Límites de recursos (`cpus`, `mem_limit`, `pids_limit`) y rotación de logs (`local`, 10 MB x 3 archivos).
- **Desarrollo (`compose.override.yaml`):**
  - Puertos publicados solo en loopback (`127.0.0.1:3000` y `127.0.0.1:5432`).
  - Bind mounts de solo lectura (`./src:/app/src:ro`, `./tsconfig.json:/app/tsconfig.json:ro`).
  - Inicialización automática de tablas vía `./database_schema_init.sql:/docker-entrypoint-initdb.d/01-init.sql:ro`.
  - Adminer 4.8.1 encapsulado en `profiles: ["debug"]`.

## 3. Checklist de verificación rápida
```bash
npm run docker:config
docker compose build --no-cache api
docker compose -f compose.yaml run --rm api id -u   # Esperado: 1000
```
- No usar etiquetas `:latest`, no correr como `root`, no incrustar secretos en `ENV`/`ARG`, y no montar `/var/run/docker.sock`.
