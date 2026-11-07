# Instrucciones Canónicas del Sistema (Recetaria API)

| Metadata | Valor |
| :--- | :--- |
| **Estándar** | SKL-PRO-001 (Nivel 1: Raíz Consciente) / ISO/IEC 26514 / IEEE 29148 |
| **Audiencia** | Desarrolladores Humanos y Agentes de Inteligencia Artificial |
| **Ámbito de Aplicación** | IDEs (Cursor, VS Code, Antigravity, OpenCode, Claude Dev, Copilot) |
| **Versión** | 1.1.0 |

---

## 1. Protocolo Operativo Agéntico (Human-in-the-Loop)

Todo agente de IA que interactúe con este repositorio debe regirse de manera estricta por las siguientes directrices de ejecución:

1. **Lectura Previa Obligatoria:** Antes de sugerir o escribir código fuente, el agente debe leer `llm.txt`, `architecture.md` y el plan activo en `doc/plan/`.
2. **Orquestación Secuencial por Fases:** El trabajo se divide en fases atómicas. El agente solo ejecuta una fase a la vez, se detiene y espera el ACK explícito del operador humano antes de avanzar a la siguiente.
3. **Detención Inmediata ante Ambigüedad:** Si un requerimiento es contradictorio o rompe las reglas del sistema (ej. intentar saltarse la validación Zod o invocar Prisma desde un servicio), el agente debe **detenerse inmediatamente**, explicar el conflicto y solicitar aclaración humana (HITL).
4. **Principio de Cambios Mínimos y Atómicos:** No generar código innecesario, no refactorizar módulos no solicitados y mantener cada cambio enfocado en una única responsabilidad.

---

## 2. Estándares Técnicos de Código

### 2.1. TypeScript Estricto
- Queda terminantemente prohibido el uso del tipo `any` (explícito o implícito).
- Toda función debe declarar tipos de entrada y tipos de retorno explícitos.
- Utilizar inferencia de tipos a partir de esquemas de Zod: `type CreateRecipeDTO = z.infer<typeof createRecipeSchema>;`.

### 2.2. Manejo de Errores y Controladores
- Cada controlador debe estar envuelto en un bloque `try/catch` o utilizar un wrapper asíncrono tipado.
- Los errores deben mapearse a códigos HTTP semánticos:
  - `400 Bad Request`: Errores de validación de Zod o sintaxis JSON inválida.
  - `401 Unauthorized`: Token ausente, firma inválida o token expirado.
  - `403 Forbidden`: Token válido pero rol insuficiente para la operación.
  - `404 Not Found`: Recurso inexistente en la base de datos.
  - `409 Conflict`: Violación de restricción única en Prisma (código `P2002`, ej. email duplicado).
  - `500 Internal Server Error`: Errores inesperados; nunca exponer el stack trace al cliente en producción.
- Toda respuesta debe apegarse al formato JSend documentado en `architecture.md`.

### 2.3. Base de Datos y Repositorios
- Las operaciones sobre la base de datos se canalizan exclusivamente mediante métodos de la capa `repositories/`.
- Las mutaciones que involucren más de un modelo (ej. aprobación de receta + log de auditoría) deben encapsularse dentro de `prisma.$transaction([...])`.
- Mantener siempre la integridad referencial y las marcas de tiempo (`createdAt`, `updatedAt`).

---

## 3. Seguridad y Gobernanza ("Always, Ask, Never")

### Always (Siempre)
- Validar todo payload con Zod antes de que toque la capa de servicios.
- Hashear contraseñas con Bcrypt antes de persistirlas.
- Exigir token JWT en todas las operaciones que no sean públicas (`POST /register`, `POST /login`, `GET /recipes`).

### Ask (Preguntar)
- Modificar o crear migraciones de base de datos (`npx prisma migrate` / `db push`).
- Instalar, actualizar o desinstalar librerías de `package.json`.
- Modificar la estructura de carpetas del proyecto.
- Ejecutar comandos de Git destructivos (`reset --hard`, `force push`).

### Never (Nunca)
- **PROHIBIDO MODIFICAR O VERSIONAR EL ARCHIVO `.env`**.
- Nunca persistir cadenas de conexión, claves API o secretos JWT en archivos de código o documentación.
- Nunca saltarse la validación de roles en endpoints protegidos.
- Nunca crear dependencias circulares entre módulos.

---

## 4. Convenciones de Nomenclatura y Git

- **Archivos:** `snake_case` para documentación y scripts (`diccionario_de_datos.md`), `kebab-case` para archivos de código TypeScript (`recipe.controller.ts`, `recipe.service.ts`).
- **Commits:** Formato *Conventional Commits* estricto:
  - `feat(modulo): descripción atómica`
  - `fix(modulo): corrección de defecto`
  - `docs: documentación o actualización de contexto`
  - `refactor(modulo): mejora de código sin cambiar comportamiento`
  - `test(modulo): adición o actualización de pruebas`
