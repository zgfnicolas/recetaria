# CLAUDE.md - Contexto y Directivas para Claude Code

> **Proyecto:** Recetaria API (Fase 1: MVP Backend)  
> **Responsable:** Facundo Nicolás González  
> **Stack:** Node.js 18+ | Express | TypeScript (Strict) | PostgreSQL 15+ | Prisma ORM | Zod | JWT | Bcrypt  
> **Gobernanza:** Este archivo se complementa con [AGENTS.md](file:///C:/Users/Facundo/dev/recetaria/AGENTS.md). Admite overrides locales en `CLAUDE.local.md`.

---

## 1. Visión y Propósito del Proyecto
API RESTful para centralizar recetas gastronómicas y cruzarlas con validación profesional de Nutricionistas y Chefs mediante un sistema de control de acceso basado en roles (RBAC).

---

## 2. Comandos Frecuentes de la CLI

```bash
# Desarrollo local
npm run dev                 # Inicia el servidor con ts-node-dev / nodemon
npm run build               # Compila TypeScript a JavaScript en dist/
npm start                   # Ejecuta el servidor compilado en producción

# Base de datos y Prisma
npx prisma validate         # Valida la sintaxis del esquema
npx prisma generate         # Genera el cliente fuertemente tipado de Prisma
npx prisma db push          # Sincroniza el esquema con PostgreSQL (Requiere permiso humano)
npx prisma migrate dev      # Crea y aplica migraciones declarativas
npx prisma studio           # Abre la interfaz visual para explorar datos

# Testing y Calidad
npm test                    # Ejecuta suites de tests unitarios y de integración
npm run test:watch          # Ejecuta tests en modo interactivo/watch
npm run lint                # Linter estático de código
```

---

## 3. Arquitectura en 4 Capas (Reglas Inviolables)

```
Cliente HTTP -> Router -> Middlewares (Zod / JWT / RBAC) -> Controller -> Service -> Repository (Prisma) -> PostgreSQL
```

1. **Router (`routes/`):** Solo mapea rutas y aplica middlewares. Ninguna lógica de negocio vive aquí.
2. **Middlewares (`middlewares/`):**
   - `validateMiddleware`: Valida `req.body`, `req.query`, `req.params` con Zod. Error -> `400 Bad Request`.
   - `authMiddleware`: Decodifica el Bearer JWT y setea `req.user = { id, role }`.
   - `rbacMiddleware([roles])`: Verifica permisos del rol. Si falla -> `403 Forbidden`.
3. **Controller (`controllers/`):** Maneja `req` y `res`, extrae parámetros, envuelve la llamada en `try/catch` y formatea la salida con el sobre JSend.
4. **Service (`services/`):** Contiene el 100% de la lógica de negocio y transacciones (`$transaction`).
   - ⚠️ **REGLA DE ORO:** El Servicio **NUNCA** instancia ni llama a Prisma directamente; solo interactúa con la capa `Repository`.
5. **Repository (`repositories/`):** Encapsula Prisma Client y expone métodos tipados (`findById`, `create`, `update`, `delete`).

---

## 4. Contrato de Respuesta Universal (JSend)

Todas las respuestas deben respetar esta estructura JSON:

```json
// Éxito (200 OK / 201 Created)
{
  "success": true,
  "statusCode": 200,
  "message": "Operación exitosa",
  "data": { ... }
}

// Error (400, 401, 403, 404, 409, 500)
{
  "success": false,
  "statusCode": 400,
  "message": "Descripción clara del error",
  "errors": [{ "field": "email", "message": "Formato inválido" }]
}
```

---

## 5. Catálogo Rápido de Endpoints (`/api/v1`)

| Método | Endpoint | Acceso / Rol | Descripción |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/auth/register` | Público | Registro de usuario (contraseña con Bcrypt). |
| `POST` | `/api/v1/auth/login` | Público | Autenticación y emisión de token JWT. |
| `GET` | `/api/v1/recipes` | Público | Listado con filtros (`?status=APPROVED&difficulty=EASY`). |
| `GET` | `/api/v1/recipes/:id` | Público | Detalle de receta por UUID. |
| `POST` | `/api/v1/recipes` | `USER`, `CHEF`, `NUTR.` | Crea receta nueva en estado `DRAFT`. |
| `PUT` | `/api/v1/recipes/:id` | Autor (Owner) | Actualización completa de receta propia. |
| `DELETE`| `/api/v1/recipes/:id` | Autor o `ADMIN` | Eliminación de receta. |
| `PUT` | `/api/v1/recipes/:id/approve` | `CHEF`, `NUTRITIONIST`| Aprobación y registro en `audit_logs` transaccional. |

---

## 6. Reglas de Gobernanza para Claude ("Always, Ask, Never")

- **ALWAYS:** Tipar fuertemente con TypeScript (prohibido `any`), validar esquemas con Zod, envolver controladores en `try/catch`.
- **ASK:** Correr migraciones de base de datos (`prisma migrate / db push`), alterar dependencias en `package.json`, o modificar la estructura de carpetas.
- **NEVER:** **PROHIBIDO TOCAR EL ARCHIVO `.env`**. Nunca persistir secretos, claves o tokens en código ni en git.

---

## 7. Módulos Adicionales de Contexto

Para pautas detalladas, consulta:
- Reglas de código y estilo: `.claude/rules/code-style.md`
- Reglas de testing: `.claude/rules/testing.md`
- Convenciones de API: `.claude/rules/api-conventions.md`
- Subagentes especializados: `.claude/agents/`
- Habilidad de despliegue: `.claude/skills/deploy/SKILL.md`
