# Skill: Operaciones y Gobernanza de Docker (`docker_ops`)

| Metadata | Valor |
| :--- | :--- |
| **Identificador** | `skl_docker_ops` |
| **Código de Skill** | SKL-DEVOPS-DKR-001 (v1.0.0) |
| **Tipo** | Funcionalidad Atómica Ejecutable (Nivel 2) |
| **Herramientas Asociadas** | Docker Engine, Docker BuildKit, Docker Compose |
| **Estándar** | ISO/IEC 26514 / IEEE 29148 / OCI |

---

## 1. Propósito y Cuándo Usar

Instruir al agente y al desarrollador sobre cómo operar, validar y diagnosticar la infraestructura de contenedores de Recetaria API bajo principios de inmutabilidad, mínimo privilegio, aislamiento de redes y defensa en profundidad.

---

## 2. Comandos Operativos

```bash
# 1. Validar la sintaxis de configuración fusionada (desarrollo)
npm run docker:config
# Equivalente: docker compose config -q

# 2. Levantar únicamente el motor PostgreSQL (Modo Híbrido)
npm run docker:db
# Equivalente: docker compose up -d postgres

# 3. Levantar entorno de desarrollo completo con hot-reload
npm run docker:dev
# Equivalente: docker compose up --build

# 4. Levantar entorno con visor web SQL (Adminer en http://localhost:8080)
npm run docker:debug
# Equivalente: docker compose --profile debug up -d

# 5. Levantar el baseline productivo inmutable y endurecido
npm run docker:prod
# Equivalente: docker compose -f compose.yaml up --build -d

# 6. Detener todos los contenedores y redes
npm run docker:down
# Equivalente: docker compose down
```

---

## 3. Checklist Senior de Verificación (SKL-DEVOPS-DKR-001)

Antes de promover cambios de infraestructura:
- [ ] **No-Root:** La imagen ejecuta como `USER node` (`uid=1000`).
- [ ] **Filesystem Endurecido:** Producción corre con `read_only: true` y `tmpfs: [/tmp]`.
- [ ] **Mínimo Privilegio:** `cap_drop: [ALL]` y `no-new-privileges:true`.
- [ ] **Aislamiento de Redes:** PostgreSQL reside en la red `data` (`internal: true`), sin salida a Internet.
- [ ] **Puertos Seguros:** En desarrollo, los puertos se publican exclusivamente a `127.0.0.1` (nunca `0.0.0.0`).
- [ ] **Healthchecks:** Ambos servicios disponen de verificaciones activas sin herramientas innecesarias en runtime.
- [ ] **Rotación de Logs:** Configurado driver `local` con límite de 10 MB por archivo.
