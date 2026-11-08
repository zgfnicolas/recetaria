# Especificación Técnica de Habilidad: Docker, Containerización y Arquitectura de Contenedores de Producción

| Atributo | Definición Técnica |
| :--- | :--- |
| **Código de Skill** | `SKL-DEVOPS-DKR-001` |
| **Identificador Interno** | `skl_docker_ops` |
| **Versión** | 1.0.0 |
| **Estándar** | ISO/IEC 26514 / IEEE 29148 / Agile DoD / OCI |
| **Habilidad Principal** | Docker, Containerización y Arquitectura de Contenedores de Producción |
| **Objetivo de Dominio** | Capacitar para diseñar, construir, securizar, ejecutar, distribuir y operar aplicaciones contenerizadas mediante Docker, aplicando principios de inmutabilidad, mínimo privilegio, reproducibilidad, aislamiento, observabilidad y eficiencia operativa. |
| **Tipo de Proyecto** | DevOps / Platform Engineering / Backend API / Infraestructura como Código (IaC) |
| **Complejidad** | Alta |
| **Paradigma Operativo** | Infrastructure as Code / Immutable Infrastructure / OCI Containers |
| **Ámbito de Ejecución** | Desarrollo local, CI/CD, QA, Staging y Producción |
| **Tecnología Principal** | Docker Engine, Docker BuildKit, Docker Compose |
| **Compatibilidad Conceptual** | OCI Containers / Kubernetes / ECS / Nomad / Swarm |

---

## 1. Filosofía de Diseño y Principios Rectores

El contenedor es tratado como una **unidad de despliegue inmutable, reproducible, efímera y aislada**. No se utiliza Docker meramente como una envoltura para correr código; el objetivo es construir un artefacto versionado que se promociona sin alteraciones entre desarrollo, integración, staging y producción:

```text
Código fuente (Git)
        │
        ▼
   Docker Build (BuildKit)
        │
        ▼
  Imagen Versionada (Inmutable)
        │
        ├──► Development (compose.override.yaml: bind mounts de lectura)
        ├──► QA / CI (ejecución de tests en contenedor limpio)
        ├──► Staging (réplica de configuración productiva)
        └──► Production (compose.yaml: hardening estricto, read-only fs)
```

### 1.1. Los 10 Principios Rectores
1. **Inmutabilidad:** Una imagen desplegada jamás se modifica en caliente. Cualquier cambio exige un nuevo commit y una nueva imagen.
2. **Reproducibilidad:** El mismo commit y lockfile (`package-lock.json`) deben producir un artefacto binariamente equivalente. Se fijan versiones exactas de base (`node:22.14.0-bookworm-slim`).
3. **Mínimo Privilegio:** Ningún proceso de aplicación corre como `root`. Se ejecuta explícitamente bajo usuario sin privilegios (`USER node`, `uid=1000`).
4. **Separación Build / Runtime:** Compiladores (`tsc`), SDKs y `devDependencies` quedan en etapas intermedias y nunca llegan a la imagen final de producción.
5. **Ephemeral First:** Los contenedores pueden destruirse y recrearse instantáneamente sin pérdida de datos ni corrupción de estado.
6. **Externalización del Estado:** La base de datos PostgreSQL persiste únicamente en volúmenes dedicados gestionados (`postgres_data`). El contenedor de la API es completamente stateless.
7. **Configuración Externa:** Secretos y variables de entorno (`DATABASE_URL`, `JWT_SECRET`) se inyectan en tiempo de ejecución (`env_file`, variables de orquestador), jamás en el `Dockerfile` ni en capas de imagen.
8. **Observabilidad:** Verificaciones de estado (`HEALTHCHECK`), métricas y registros estructurados orientados a `stdout`/`stderr` con rotación gestionada (`driver: local`).
9. **Aislamiento:** Segmentación estricta de redes (`application` bridge y `data` interna sin acceso a Internet) y limitación de capacidades Linux (`cap_drop: [ALL]`).
10. **Automatización:** Definición declarativa en código versionado (`Dockerfile`, `compose.yaml`, `compose.override.yaml`, `package.json`).

---

## 2. Arquitectura Implementada en Recetaria API

La infraestructura de Docker de Recetaria API se compone de 4 artefactos principales que interactúan de forma desacoplada:

```text
recetaria/
├── .dockerignore              # Filtrado de contexto (evita context bloat y fuga de secretos)
├── Dockerfile                 # Multi-stage de 5 fases (base, deps, development, build, runtime)
├── compose.yaml               # Baseline productivo endurecido (seguridad, cuotas, redes)
└── compose.override.yaml      # Override automático de desarrollo local (hot-reload, loopback, debug)
```

### 2.1. `.dockerignore` (Optimización y Protección de Contexto)
Excluye sistemáticamente del contexto de build:
- `.git`, `.gitignore`: Evita invalidar la caché de capas en cada commit y previene filtración del historial git.
- `node_modules`: Fuerza que las dependencias se resuelvan e instalen de forma determinista dentro del contenedor con `npm ci`.
- `dist`: Evita mezclar compilaciones locales previas con la compilación limpia del contenedor.
- `.env*` (excepto `.env.example`): Salvaguarda crítica para que ninguna credencial local ingrese en las capas OCI.
- `.ai`, `.claude`, `docs`, `*.md`: Evita invalidar capas por cambios en documentación o prompts de IA.

### 2.2. `Dockerfile` Multi-Stage (5 Etapas)
Construido sobre `node:22.14.0-bookworm-slim` (Debian Bookworm con `glibc`), garantizando compatibilidad con Prisma ORM 7 (`node >= 22.12`) y compilaciones nativas C++ de `bcrypt`:

```text
┌─────────────────────────────────────────────────────────────┐
│ 1. base (node:22.14.0-bookworm-slim, WORKDIR /app)          │
└──────────────┬──────────────────────────────┬───────────────┘
               │                              │
               ▼                              ▼
┌──────────────────────────────┐ ┌────────────────────────────┐
│ 2. deps                      │ │ 3. development             │
│ --mount=type=cache (/root)   │ │ target para desarrollo     │
│ npm ci + prisma generate     │ │ ts-node-dev + USER node    │
└──────────────┬───────────────┘ └────────────────────────────┘
               │
               ▼
┌──────────────────────────────┐
│ 4. build                     │
│ npm run build (tsc)          │
│ npm prune --omit=dev         │
└──────────────┬───────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. runtime (Producción)                                     │
│ Copia solo dist/ y node_modules/ de producción               │
│ USER node (uid=1000)                                        │
│ HEALTHCHECK nativo: node -e "fetch(...)"                    │
│ CMD ["node", "dist/index.js"] (Exec JSON, PID 1)            │
└─────────────────────────────────────────────────────────────┘
```

#### Características Clave del `Dockerfile`:
- **BuildKit Cache Mount:** `RUN --mount=type=cache,target=/root/.npm npm ci` reutiliza la caché del gestor de paquetes del host entre builds sin persistir archivos innecesarios en la imagen final.
- **Principio de Mínimo Privilegio:** Asignación explícita de `USER node` y carpetas con `--chown=node:node`.
- **Healthcheck Nativo:** Se aprovecha la API global `fetch` incorporada en Node 22 para consultar `/health`, evitando instalar paquetes adicionales como `curl` o `wget` que aumentarían la superficie de ataque.
- **Manejo de Señales (PID 1):** `CMD ["node", "dist/index.js"]` en formato exec (JSON array) permite que Node.js reciba directamente `SIGTERM` y `SIGINT` para un apagado ordenado (*Graceful Shutdown*).

### 2.3. `compose.yaml` (Baseline Productivo Endurecido)
Define el estándar de ejecución para entornos de producción, staging o réplicas de evaluación:
- **Filesystem de solo lectura:** `read_only: true` bloquea cualquier escritura en el sistema de archivos del contenedor. Los temporales se canalizan vía `tmpfs: [/tmp]`.
- **Drop de capacidades Linux:** `cap_drop: [ALL]` y `security_opt: [no-new-privileges:true]` eliminan la posibilidad de escalada de privilegios o explotación de binarios setuid.
- **Aislamiento de Redes:**
  - Red `application`: Red tipo bridge accesible para tráfico de API.
  - Red `data` (`internal: true`): Segmento aislado sin puerta de enlace a Internet. PostgreSQL solo se comunica con la API en esta red privada.
- **Orquestación por Salud Real:** `depends_on: postgres: condition: service_healthy` previene que la API inicie antes de que PostgreSQL acepte conexiones (`pg_isready -U postgres -d recetaria`).
- **Límites de Recursos:** Cuotas estrictas de CPU (`cpus: "1.5"`), memoria (`mem_limit: 512M`) y procesos (`pids_limit: 100`) para mitigar ataques DoS o agotamiento de recursos (*fork bombs*).
- **Rotación de Logs:** Configuración del driver `local` con tope de 10 MB y máximo 3 archivos rotados.

### 2.4. `compose.override.yaml` (Desarrollo Local y Hot-Reload)
Docker Compose fusiona automáticamente `compose.yaml` + `compose.override.yaml` al invocar `docker compose up` en el directorio de trabajo:
- **Target `development`:** Construye hasta la etapa 3, conservando `ts-node-dev` y herramientas de tipado.
- **Bind Mounts de Solo Lectura:** `./src:/app/src:ro` y `./tsconfig.json:/app/tsconfig.json:ro` permiten recarga en vivo inmediata al editar código sin comprometer la integridad de la carpeta `/app` en el contenedor.
- **Enlace de Red Loopback (`127.0.0.1`):** Los puertos se publican exclusivamente a la interfaz local (`127.0.0.1:3000:3000` y `127.0.0.1:5432:5432`), evitando exposición accidental a la red física local o Wi-Fi.
- **Aprovisionamiento Automático de BD:** `./database_schema_init.sql:/docker-entrypoint-initdb.d/01-init.sql:ro` inicializa las tablas relacionales de Recetaria al levantar la base por primera vez.
- **Herramienta Debugging Opcional:** Servicio `adminer:4.8.1` encapsulado bajo `profiles: ["debug"]`, levantándose únicamente cuando el desarrollador lo solicita explícitamente (`npm run docker:debug`).

---

## 3. Matriz de Comandos Operativos

Los comandos se gestionan mediante scripts npm que abstraen la invocación de Docker CLI:

| Script npm | Comando Docker CLI Subyacente | Propósito y Cuándo Usar |
| :--- | :--- | :--- |
| `npm run docker:config` | `docker compose config -q` | Valida estáticamente la sintaxis y el resultado de la fusión YAML sin levantar contenedores. |
| `npm run docker:db` | `docker compose up -d postgres` | **Modo Híbrido:** Levanta únicamente PostgreSQL contenerizado para desarrollar en local con Node del host. |
| `npm run docker:dev` | `docker compose up --build` | **Modo Full Docker:** Levanta todo el stack con hot-reload en desarrollo (`target: development`). |
| `npm run docker:debug` | `docker compose --profile debug up -d` | Activa el perfil de depuración e inicia la GUI web de base de datos Adminer en `http://localhost:8080`. |
| `npm run docker:prod` | `docker compose -f compose.yaml up --build -d` | **Simulación Productiva:** Ignora el override y corre el contenedor inmutable endurecido de runtime. |
| `npm run docker:down` | `docker compose down` | Detiene y destruye los contenedores y redes asociadas (preservando el volumen de datos persistente). |

### 3.1. Operaciones de Diagnóstico e Inspección en Caliente
```bash
# Ver estado y health de los contenedores
docker compose ps

# Inspeccionar logs de un servicio específico
docker compose logs -f api
docker compose logs -f postgres

# Ejecutar comandos dentro del contenedor en ejecución
docker compose exec api node -v
docker compose exec postgres psql -U postgres -d recetaria -c "\dt"

# Detener eliminando volúmenes (¡ATENCIÓN: BORRA LA BASE DE DATOS LOCAL!)
docker compose down -v
```

---

## 4. Requisitos del Sistema

### 4.1. Requisitos Funcionales (`RF`)
- **`[RF-01]` Multi-Stage Build:** El `Dockerfile` debe implementar un esquema multi-etapa separando dependencias, compilación y runtime. *(Cumplido en `Dockerfile` etapas 1 a 5).*
- **`[RF-02]` Inmutabilidad de Imagen:** La imagen generada debe ser idéntica para cualquier entorno de despliegue. *(Cumplido mediante parametrización por variables de entorno).*
- **`[RF-03]` Reproducibilidad de Dependencias:** Uso estricto de `npm ci` anclado a `package-lock.json`. *(Cumplido en etapa `deps`).*
- **`[RF-04]` Poda de Dependencias de Desarrollo:** `npm prune --omit=dev` antes de transferir artefactos al runtime. *(Cumplido en etapa `build`).*
- **`[RF-05]` Compilación Aislada:** Compilación TypeScript (`tsc`) ejecutada dentro del contenedor, sin requerir compilador en el host. *(Cumplido en etapa `build`).*
- **`[RF-06]` Integración de Cliente ORM:** Generación de Prisma Client en build time (`prisma generate`). *(Cumplido en etapa `deps`).*
- **`[RF-07]` Manejo de Estado Persistente:** Persistencia de PostgreSQL mediante volumen con nombre (`postgres_data`). *(Cumplido en `compose.yaml`).*
- **`[RF-08]` Inicialización de Esquema SQL:** Carga automática del esquema inicial en PostgreSQL durante el primer arranque local. *(Cumplido en `compose.override.yaml`).*
- **`[RF-09]` Recarga en Vivo (Hot-Reload):** Sincronización inmediata de código mediante bind mounts de solo lectura y `ts-node-dev`. *(Cumplido en `compose.override.yaml`).*
- **`[RF-10]` Orquestación Condicional de Arranque:** Bloqueo de inicio de la API hasta que la base esté completamente saludable (`condition: service_healthy`). *(Cumplido en `compose.yaml`).*
- **`[RF-11]` Verificación de Salud Integrada (Healthcheck API):** Endpoint `/health` verificado a intervalos regulares con `node fetch`. *(Cumplido en `Dockerfile`).*
- **`[RF-12]` Verificación de Salud Integrada (Healthcheck BD):** `pg_isready` verificado a intervalos de 5 segundos. *(Cumplido en `compose.yaml`).*
- **`[RF-13]` Segmentación de Redes:** Separación física de tráfico público y capa de datos interna. *(Cumplido mediante redes `application` y `data`).*
- **`[RF-14]` Aislamiento Loopback en Desarrollo:** Publicación de puertos restringida a `127.0.0.1`. *(Cumplido en `compose.override.yaml`).*
- **`[RF-15]` Interfaz de Gestión SQL Opcional:** Adminer encapsulado en perfil `debug`. *(Cumplido en `compose.override.yaml`).*
- **`[RF-16]` Validación Declarativa de Configuración:** Script de verificación de sintaxis Compose. *(Cumplido con `npm run docker:config`).*
- **`[RF-17]` Apagado Ordenado (Graceful Shutdown):** Propagación de `SIGTERM` y tiempo de espera de 15 segundos (`stop_grace_period: 15s`). *(Cumplido en `compose.yaml` y formato exec `CMD`).*
- **`[RF-18]` Manejo de Inyección de Configuración:** Inyección externa mediante `.env` sin quemar valores en la imagen. *(Cumplido en `compose.yaml`).*
- **`[RF-19]` Inicializador de Procesos Zombie:** Flag `init: true` (`tini`) para gestión de señales y procesos huérfanos. *(Cumplido en `compose.yaml`).*
- **`[RF-20]` Automatización de Flujos:** Scripts unificados en `package.json` (`docker:config`, `docker:db`, `docker:dev`, `docker:debug`, `docker:prod`, `docker:down`). *(Cumplido en `package.json`).*

### 4.2. Requisitos No Funcionales (`RNF`)
- **`[RNF-01]` Seguridad de Usuario No-Root:** Ejecución como usuario sin privilegios `node` (`uid=1000`).
- **`[RNF-02]` Hardening de Filesystem:** Contenedor de producción montado como `read_only: true` con `/tmp` efímero en memoria.
- **`[RNF-03]` Reducción de Capacidades del Kernel:** Revocación total de capacidades (`cap_drop: [ALL]`).
- **`[RNF-04]` Prevención de Escalada de Privilegios:** Restricción de nuevos privilegios activada (`no-new-privileges:true`).
- **`[RNF-05]` Mitigación de Denegación de Servicio (DoS):** Asignación de cuotas de CPU, memoria y límite de procesos en kernel.
- **`[RNF-06]` Eficiencia de Caché de Construcción:** Cache mount de BuildKit para evitar descargas redundantes de paquetes npm.
- **`[RNF-07]` Contexto Mínimo de Build:** Exclusión estricta de artefactos, secretos y fuentes no requeridas en `.dockerignore`.
- **`[RNF-08]` Gobernanza de Almacenamiento de Logs:** Límite rotativo de logs a nivel daemon/compose (10 MB x 3 archivos).
- **`[RNF-09]` Compatibilidad Binaria de Arquitectura:** Compatibilidad garantizada para Prisma ORM y C++ nativo (`bcrypt`).
- **`[RNF-10]` Trazabilidad y Determinismo:** Fijación semántica exacta de versiones en imágenes base (`node:22.14.0-bookworm-slim`, `postgres:15.12-alpine`, `adminer:4.8.1`).
- **`[RNF-11]` Tiempo de Recuperación (MTTR):** Reinicio automático ante fallos transitorios (`restart: unless-stopped`).
- **`[RNF-12]` Confidencialidad de Secretos:** Prohibición absoluta de variables de entorno con credenciales en directivas `ENV` o `ARG` del `Dockerfile`.

---

## 5. Catálogo de los 20 Antipatrones Prohibidos

El desarrollo y la operación de Recetaria prohíben estrictamente los siguientes 20 antipatrones:

### `[Antipatrón 1]` Usar la etiqueta `:latest` en imágenes base
- **Peligro:** Rompe el determinismo y la reproducibilidad. Un cambio imprevisto en la imagen remota puede romper el pipeline o introducir vulnerabilidades de seguridad.
- **Mitigación en Recetaria:** Se usan tags exactos: `node:22.14.0-bookworm-slim` y `postgres:15.12-alpine`.

### `[Antipatrón 2]` Ejecutar contenedores como usuario `root` (`uid=0`)
- **Peligro:** Si un atacante compromete la aplicación vía ejecución remota de código (RCE), obtiene privilegios de root dentro del contenedor y potencialmente en el kernel del host.
- **Mitigación en Recetaria:** Se declara `USER node` explícitamente en las etapas de desarrollo y runtime.

### `[Antipatrón 3]` Incrustar secretos o credenciales en el `Dockerfile` (`ENV` / `ARG`)
- **Peligro:** Los valores quedan grabados permanentemente en las capas de la imagen y son accesibles mediante `docker history` o inspección de imagen.
- **Mitigación en Recetaria:** El `Dockerfile` no declara variables sensibles. Toda configuración se inyecta en runtime vía variables de entorno o archivos externos.

### `[Antipatrón 4]` Omitir el archivo `.dockerignore`
- **Peligro:** Transfiere carpetas gigantescas (`node_modules`, `.git`), enlentece la subida de contexto a BuildKit y puede enviar archivos de credenciales (`.env`) al daemon de Docker.
- **Mitigación en Recetaria:** `.dockerignore` filtra minuciosamente git, dependencias locales, documentación y credenciales.

### `[Antipatrón 5]` Ejecutar `npm install` en lugar de `npm ci` en el build
- **Peligro:** `npm install` puede modificar el árbol de dependencias, descargar versiones no comprobadas de librerías y romper la reproducibilidad del artefacto.
- **Mitigación en Recetaria:** Uso estricto de `npm ci` respaldado por `package-lock.json`.

### `[Antipatrón 6]` Conservar dependencias de desarrollo (`devDependencies`) en la imagen final
- **Peligro:** Incrementa exponencialmente el tamaño de la imagen y expande drásticamente la superficie de vulnerabilidades con librerías que solo son útiles en desarrollo.
- **Mitigación en Recetaria:** Multi-stage build con `npm prune --omit=dev` y copia selectiva únicamente de la carpeta `dist/` y `node_modules` de producción.

### `[Antipatrón 7]` Almacenar estado persistente dentro de la capa escribible del contenedor
- **Peligro:** Al destruirse o actualizarse el contenedor, los datos de base de datos o subidas de usuario se pierden irremediablemente.
- **Mitigación en Recetaria:** Uso de volúmenes persistentes gestionados (`postgres_data`).

### `[Antipatrón 8]` Publicar puertos en todas las interfaces (`0.0.0.0`) durante desarrollo local
- **Peligro:** Expone la base de datos y la API interna a cualquier máquina conectada a la misma red local o Wi-Fi.
- **Mitigación en Recetaria:** Publicación estricta al loopback `127.0.0.1` en `compose.override.yaml`.

### `[Antipatrón 9]` Usar formato Shell en lugar de formato Exec para `ENTRYPOINT` / `CMD`
- **Peligro:** `CMD node dist/index.js` lanza el comando dentro de `/bin/sh -c`. Node no recibe `PID 1` y no captura las señales `SIGTERM`/`SIGINT`, provocando que Docker mate el contenedor bruscamente con `SIGKILL` tras el timeout.
- **Mitigación en Recetaria:** Uso de array JSON: `CMD ["node", "dist/index.js"]` y habilitación de `init: true`.

### `[Antipatrón 10]` Usar `depends_on` básico sin validación de `service_healthy`
- **Peligro:** Compose solo espera a que el contenedor de la BD esté creado, no a que el motor PostgreSQL haya levantado sockets y acepte conexiones. La API falla al iniciar por conexión rechazada.
- **Mitigación en Recetaria:** `depends_on` con `condition: service_healthy` atado a `pg_isready`.

### `[Antipatrón 11]` Instalar herramientas diagnósticas pesadas (`curl`, `wget`, `net-tools`) en la imagen de producción
- **Peligro:** Aumenta el vector de ataque al proveer herramientas útiles para un atacante que logra shell en el contenedor.
- **Mitigación en Recetaria:** El healthcheck se realiza directamente con el runtime de Node.js mediante `node -e "fetch(...)"`.

### `[Antipatrón 12]` Correr sin límites de recursos de cómputo (`cpu`, `memory`, `pids`)
- **Peligro:** Un memory leak o un loop infinito en la API puede agotar la memoria de toda la máquina anfitriona (OOM Killer matando servicios críticos del host).
- **Mitigación en Recetaria:** Cuotas declaradas explícitamente en `compose.yaml` (`mem_limit: 512M`, `cpus: "1.5"`, `pids_limit: 100`).

### `[Antipatrón 13]` Contenedores con sistema de archivos en modo lectura/escritura en producción
- **Peligro:** Permite a un atacante inyectar scripts, modificar código compilado en `dist/` o descargar binarios maliciosos al contenedor.
- **Mitigación en Recetaria:** Activación de `read_only: true` con solo `/tmp` montado en `tmpfs`.

### `[Antipatrón 14]` Mantener capacidades Linux completas (`capabilities`) por defecto
- **Peligro:** Muchas capacidades por defecto no son requeridas por una API Node y permiten interacción peligrosa con el kernel del host si se produce un escape.
- **Mitigación en Recetaria:** `cap_drop: [ALL]` y `security_opt: [no-new-privileges:true]`.

### `[Antipatrón 15]` Mezclar servicios en una única red plana por defecto
- **Peligro:** Si la base de datos comparte la misma red de cara al público, cualquier contenedor comprometido o expuesto puede interactuar con ella sin barreras.
- **Mitigación en Recetaria:** Red segmentada `data` configurada como `internal: true`.

### `[Antipatrón 16]` Emitir logs a archivos locales dentro del contenedor sin rotación
- **Peligro:** Los archivos de texto crecen hasta colapsar el almacenamiento del disco físico del host.
- **Mitigación en Recetaria:** Logs emitidos a `stdout`/`stderr` gestionados por el driver `local` con rotación (`max-size: 10m`, `max-file: 3`).

### `[Antipatrón 17]` Montar el socket de Docker (`/var/run/docker.sock`) dentro del contenedor de la aplicación
- **Peligro:** Entrega control total del Docker daemon del host al contenedor (equivalente a acceso root en el host).
- **Mitigación en Recetaria:** Prohibición absoluta de mapear el socket de Docker en los servicios de la aplicación.

### `[Antipatrón 18]` Modificar manualmente contenedores en ejecución con `docker exec` en producción
- **Peligro:** Genera desvío de configuración (*configuration drift*), rompe la reproducibilidad e invalida cualquier proceso de auditoría.
- **Mitigación en Recetaria:** Cualquier cambio requiere commit en Git, build automatizado y sustitución del contenedor inmutable.

### `[Antipatrón 19]` Correr múltiples servicios pesados en un solo contenedor sin supervisor
- **Peligro:** Ejecutar Node.js y PostgreSQL en el mismo contenedor rompe la separación de responsabilidades, complica el monitoreo y causa fallos silenciosos de procesos.
- **Mitigación en Recetaria:** Principio de una responsabilidad por contenedor; PostgreSQL y API corren en servicios desacoplados en Compose.

### `[Antipatrón 20]` Invalidación innecesaria de la caché de capas de Docker
- **Peligro:** Ejecutar `COPY . .` antes de `COPY package*.json` fuerza a reinstalar todas las dependencias ante un cambio de una sola línea de código, multiplicando el tiempo de compilación.
- **Mitigación en Recetaria:** Estructuración optimizada: primero se copian `package*.json` y `prisma/schema.prisma`, se ejecutan `npm ci` y `prisma generate`, y recién después se copia el resto del código fuente.

---

## 6. Protocolo de Validación Técnica y Pruebas de Resiliencia

### 6.1. Procedimiento de Auditoría Técnica (Fase 34)
Antes de promover cambios de infraestructura a ramas de integración o producción, se deben ejecutar las siguientes verificaciones:

```bash
# 1. Validación sintáctica y estructural de Compose
npm run docker:config

# 2. Construcción limpia de la imagen sin usar caché previa
docker compose build --no-cache api

# 3. Comprobar que el usuario de ejecución no es root (uid != 0)
docker compose run --rm api id -u
# Salida esperada: 1000

# 4. Comprobar que el filesystem productivo es estrictamente de solo lectura
docker compose -f compose.yaml run --rm api touch /app/test_write.txt
# Salida esperada: touch: cannot touch '/app/test_write.txt': Read-only file system

# 5. Comprobar que el directorio efímero /tmp sí permite escritura
docker compose -f compose.yaml run --rm api touch /tmp/test_ok.txt
# Salida esperada: código de retorno 0 (éxito)

# 6. Escaneo estático de vulnerabilidades en la imagen generada
docker scout cves recetaria-api:latest || trivy image recetaria-api:latest
```

### 6.2. Procedimiento de Pruebas de Resiliencia (Fase 35)
1. **Prueba de Resistencia de Base de Datos:**
   - Detener temporalmente el contenedor de PostgreSQL (`docker compose stop postgres`).
   - Verificar que la API no colapse catastróficamente el contenedor, sino que devuelva errores HTTP 503 formateados bajo estándar JSend.
   - Reanudar PostgreSQL (`docker compose start postgres`).
   - Confirmar reconexión automática del pool de conexiones sin necesidad de reiniciar la API.
2. **Prueba de Graceful Shutdown:**
   - Enviar señal `SIGTERM` al contenedor de la API (`docker compose stop -t 10 api`).
   - Inspeccionar los logs (`docker compose logs api`) para confirmar que el servidor cerró las conexiones activas antes de finalizar el proceso.

---

## 7. Checklist Senior de Revisión (30 Puntos)

### 7.1. Construcción y Dockerfile (Puntos 1 a 8)
- [ ] **1.** La imagen base usa una versión específica y no `:latest`.
- [ ] **2.** Se utiliza multi-stage build separando dependencias, compilación y runtime.
- [ ] **3.** Las dependencias se instalan con `npm ci` determinista.
- [ ] **4.** Las dependencias de desarrollo (`devDependencies`) no están en la imagen de producción.
- [ ] **5.** Se utiliza `--mount=type=cache` de BuildKit para optimizar descargas.
- [ ] **6.** El orden de las capas optimiza la caché (archivos de paquetes antes del código fuente).
- [ ] **7.** El archivo `.dockerignore` está presente y excluye `.git`, `node_modules`, `.env*` y artefactos locales.
- [ ] **8.** El comando final (`CMD`) está en formato exec (JSON array) y no en shell form.

### 7.2. Seguridad y Privilegios (Puntos 9 a 15)
- [ ] **9.** El contenedor corre bajo un usuario no-root (`USER node`, `uid=1000`).
- [ ] **10.** El filesystem en producción está configurado como solo lectura (`read_only: true`).
- [ ] **11.** Se monta un `tmpfs` exclusivo en `/tmp` para escrituras temporales indispensables.
- [ ] **12.** Se revocan todas las capacidades del kernel (`cap_drop: [ALL]`).
- [ ] **13.** Se bloquea la escalada de privilegios (`no-new-privileges:true`).
- [ ] **14.** No existen secretos, API keys o contraseñas en directivas `ENV` o `ARG` del `Dockerfile`.
- [ ] **15.** El socket de Docker del host no está montado en ningún contenedor.

### 7.3. Operación y Observabilidad (Puntos 16 a 22)
- [ ] **16.** Ambos servicios (`api` y `postgres`) tienen directivas de `HEALTHCHECK` configuradas.
- [ ] **17.** El healthcheck de la API no depende de binarios innecesarios como `curl` en la imagen de producción.
- [ ] **18.** La aplicación gestiona señales de apagado (`SIGTERM`) de forma ordenada (*Graceful Shutdown*).
- [ ] **19.** Se utiliza `init: true` o un init process para manejar procesos zombie y señales.
- [ ] **20.** Los logs se emiten a `stdout`/`stderr` en formato estructurado.
- [ ] **21.** Se define una política de rotación de logs (tamaño máximo y número de archivos).
- [ ] **22.** Los contenedores tienen política de reinicio definida (`restart: unless-stopped`).

### 7.4. Compose y Entorno (Puntos 23 a 30)
- [ ] **23.** Se separan las configuraciones mediante `compose.yaml` (base) y `compose.override.yaml` (desarrollo).
- [ ] **24.** Los puertos de desarrollo están atados exclusivamente al loopback (`127.0.0.1`).
- [ ] **25.** Las redes están segmentadas (red interna para la base de datos sin salida a Internet).
- [ ] **26.** La dependencia de arranque utiliza `condition: service_healthy`.
- [ ] **27.** Los datos persistentes residen exclusivamente en volúmenes nombrados gestionados.
- [ ] **28.** Se configuran límites de recursos (CPU, memoria y procesos) para producción.
- [ ] **29.** Las herramientas de depuración (ej. Adminer) están aisladas bajo perfiles opcionales (`profiles: ["debug"]`).
- [ ] **30.** La configuración se valida exitosamente con `docker compose config -q`.

---

## 8. Indicadores Clave de Desempeño (KPIs)

| Métrica | Objetivo Técnico | Estado en Recetaria |
| :--- | :--- | :--- |
| **Tiempo de Build en Frío** | < 120 segundos | ~45-60 s (gracias a Debian Bookworm slim) |
| **Tiempo de Build Incremental** | < 10 segundos | ~2-4 s (gracias a caché de capas y BuildKit cache) |
| **Tamaño de Imagen Runtime** | < 250 MB | ~180-210 MB (sin TypeScript, sin tests, sin compiladores) |
| **Vulnerabilidades Críticas / Altas** | 0 reportes | 0 en imagen oficial `node:22.14.0-bookworm-slim` |
| **Tiempo de Recuperación de Salud** | < 10 segundos | Healthcheck cada 15s con respuesta inmediata |
| **Consumo de Memoria en Reposo** | < 100 MB (API) | ~45-60 MB en arranque Node.js Express |
