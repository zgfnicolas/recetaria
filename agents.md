### Identificación del Proyecto

| Campo | Detalles |
| --- | --- |
| **Nombre del Proyecto** | Recetaria (Fase 1: MVP Backend API) - Contexto de Agente IA |
| **Versión / Revisión** | 1.0.0 |
| **Fecha de Creación** | 06/11/2026 |
| **Estado** | Aprobado |
| **Responsable Técnico** | Facundo Nicolás González |
| **Fecha de Última Revisión** | 06/11/2026 |
| **Recursos** | Trabajo práctico integrador, `schema.prisma` |

### 1. Directivas Técnicas y Mandato del Sistema

**Propósito Operativo:** Desarrollar y mantener la API REST del proyecto "Recetaria", garantizando el cumplimiento estricto de los requisitos técnicos del sistema (arquitectura en 4 capas desacopladas, tipado estricto en TypeScript, validación con esquemas Zod, autenticación JWT stateless y controladores con try/catch y retorno JSend).

* **Axioma principal:** El código debe ser modular, simple y mantener una separación estricta de responsabilidades (Routing -> Controladores -> Servicios -> Repositorios).
* **Enfoque de Ejecución:** Focalizar en **cambios cortos, específicos y focalizados**. Resolver un problema a la vez de forma atómica. Priorizar siempre la legibilidad y el cumplimiento de los esquemas de validación (Zod) antes de proponer cualquier lógica adicional.

### 2. Contexto del Proyecto

* **Propósito:** Backend para una plataforma donde los usuarios buscan y publican recetas, las cuales son validadas y categorizadas por profesionales (Nutricionistas y Chefs) mediante un sistema estricto de roles.
* **Ecosistema tecnológico:** Node.js, Express, TypeScript, Prisma ORM, PostgreSQL, Zod (Validación), Bcrypt y JSON Web Tokens (JWT).
* **Objetivo actual:** Finalizar el MVP Académico (Semana 2 del Bootcamp) enfocado exclusivamente en las entidades `User` y `Recipe`, aprobando el CRUD, autenticación, middlewares y relaciones base.

### 3. El Sistema de gobernanza: "Always, ask, never"

Para maximizar la eficiencia y evitar introducir deuda técnica o fallos catastróficos en el repositorio, el agente debe regirse por los siguientes niveles de acción:

| Nivel | Acciones Permitidas / Mandatos |
| --- | --- |
| **Always (Siempre)** | Focalizarse en el código actual. Tipar fuertemente con TypeScript, sugerir implementaciones de controladores o servicios atómicos, ejecutar linters estáticos, y asegurar que cada controlador tenga su bloque `try/catch`. |
| **Ask (Preguntar)** | **(RESTRICCIÓN ESTRICTA):** Ejecutar comandos de git, correr migraciones de base de datos (`npx prisma migrate / db push`), alterar la arquitectura de carpetas, cambiar versiones en el `package.json`, o añadir/quitar librerías. Todo esto requiere confirmación explícita del humano. |
| **Never (Nunca)** | **PROHIBIDO TOCAR EL ARCHIVO `.env`.** Nunca exponer claves API o cadenas de conexión. Nunca inyectar dependencias circulares ni saltarse la validación de roles y esquemas. |

### 4. Arquitectura y reglas de capas

El agente debe respetar ciegamente los límites arquitectónicos definidos para los componentes (`/modules`). Las violaciones de estas fronteras deben ser reportadas antes de escribir código.

* **Regla de oro:** La capa de `Service` (reglas de negocio) nunca debe instanciar a Prisma directamente; debe llamar a la capa de `Repository`. Los `Controllers` solo manejan los objetos `req` y `res`, delegando toda la lógica al `Service`.
* **Manejo de errores:** Todo error predecible debe ser capturado y formateado antes de llegar al cliente (ej. Errores de Zod retornan 400; Errores de Prisma como `Unique constraint` retornan 409).

### 5. Contrato de validación (Build/Test)

Antes de dar por finalizada una tarea, el agente debe asegurar que el código esté listo para el bucle de retroalimentación humano:

1. **Transpilación:** El código TypeScript sugerido no debe arrojar errores de tipo `any` implícito.
2. **Consistencia Zod:** Si se altera el esquema de Prisma, el agente debe recordar actualizar el `schema` de validación de Zod correspondiente.
3. **Pruebas de Integración:** Verificar mentalmente si el endpoint sugerido pasaría la prueba de Thunder Client exigida por la rúbrica (Manejo de 200, 201, 400, 401, 403, 404).

### 6. Registro de cambios, Flujo Git y Decisiones

El flujo de trabajo debe ser atómico para mantener un historial inmaculado:

* **Ramas (GitFlow):** Para cada nueva feature o fix sugerido, el agente **debe analizar y sugerir la creación de una rama modular**. Ejemplo: *"Te sugiero crear la rama `feature/recipe-filters` para implementar esto"*.
* **Formato de Commit:** Sugerir siempre mensajes de commit atómicos y semánticos (Conventional Commits). Ejemplo: `feat(recipes): agregar filtro de dificultad en el servicio` o `fix(auth): manejar expiración de token JWT`.
* **ADR (Decisiones):** No re-litigar el stack. PostgreSQL y Prisma son las decisiones finales del proyecto.

### 7. Mapa de directorios críticos

| Directorio / Archivo | Función para la IA |
| --- | --- |
| `llm.txt` / `architecture.md` / `instructions.md` | **Nivel 1 (Raíz Consciente):** Directivas canónicas, macro-arquitectura y resumen hiper-denso. |
| `.ai/` | **Nivel 2 (Arsenal Táctico):** Skills ejecutables, sub-agentes especializados y plantillas de prompts. |
| `doc/` | **Nivel 3 y 4 (Especificación y Planes):** SDD (`architecture/`, `rules/`, `modules/`) y orquestación activa en `plan/`. |
| `src/modules/` | Carpeta principal de trabajo (Users, Recipes, Auth). Contiene el patrón Router -> Controller -> Service -> Repository. |
| `src/middlewares/` | Lógica transversal: Interceptores de JWT, validación Zod y RBAC (Roles). |
| `prisma/schema.prisma` | **La Fuente de la Verdad:** Define la base de datos relacional y las entidades. (Solo lectura, modificar previo permiso). |
| `.env.example` | Plantilla segura de variables de entorno para usar de referencia. |

### 8. Protocolo de Handoff

Si el agente de IA se encuentra ante una instrucción del usuario que rompe la arquitectura del sistema, que solicita modificar el archivo `.env`, o ejecutar un comando de migración destructivo, el agente **debe detenerse inmediatamente**, explicar el riesgo técnico o la violación a la regla de gobernanza, y solicitar directivas al usuario (Facundo) para proceder de forma segura.

**Responsable del modelo:** Facundo Nicolás González
**Fecha de revisión:** 06/11/2026
**Documentos de referencia:** Trabajo práctico integrador