# Cómo contribuir

¡Gracias por colaborar con Recetaria! Esta guía resume el entorno local, el flujo de trabajo y los estándares del repositorio.

## Entorno de desarrollo
Requisitos: Node.js 22+, Docker Desktop (Compose v2) y Git.

1. Copiar `.env.example` a `.env` y completar los valores locales (nunca versionar `.env`).
2. Levantar la base de datos: `npm run docker:db`
3. Instalar dependencias y arrancar el servidor: `npm install && npm run dev`

## Flujo de trabajo (GitHub Flow)
1. Crear una rama desde `main`: `feat/recipe-filters`, `fix/jwt-expiration`, `docs/update-sad`.
2. Usar **Conventional Commits**:
   - `feat(recipes): agrega filtro por dificultad`
   - `fix(auth): corrige expiración del token JWT`
   - `docs:`, `refactor:`, `test:`, `chore:`
3. Abrir un Pull Request hacia `main` completando el template en `.github/pull_request_template.md`.
4. Verificar compilación (`npm run build`), tests (`npm test`) y configuración Docker (`npm run docker:config`) antes de mergear.

## Estándares de código
- **TypeScript estricto:** prohibido el uso de `any`; inferir DTOs con `z.infer<typeof schema>`.
- **Arquitectura en 4 capas:** `Router -> Controller -> Service -> Repository`. Solo `Repository` interactúa con Prisma Client.
- **Controladores:** manejan exclusivamente `req`/`res`, envuelven llamadas en `try/catch` y devuelven el sobre JSend (`{ success, statusCode, message, data/errors }`).
- **Nomenclatura:** `kebab-case.ts` para archivos (`recipe.service.ts`), `PascalCase` para clases e interfaces, `camelCase` para funciones y variables.

## Configuración de Antigravity CLI
El proyecto está optimizado para trabajar con Antigravity CLI (`agy`):
1. Copiá las reglas recomendadas de [`docs/antigravity-settings.example.json`](docs/antigravity-settings.example.json) en tu archivo personal `~/.gemini/antigravity-cli/settings.json` para activar el sandbox de terminal y proteger `.env`.
2. Usá `/plan` antes de modificar lógica de negocio o modelos de datos y ejecutá los planes de `docs/plans/` de a una fase por vez.
3. Los hooks de seguridad en `.agents/hooks.json` se aplican automáticamente a todo el equipo para bloquear acceso a `.env`, `secrets/` y comandos destructivos.

## Tests
- `npm test` ejecuta las pruebas unitarias y de integración.
- Todo PR con lógica nueva debe incluir pruebas unitarias (mockeando solo el `Repository`) o de integración (Supertest), y actualizar la colección de Thunder Client cuando corresponda.

## Documentación
Si el cambio modifica una regla de negocio, un rol, el modelo de datos o la arquitectura, actualizá el documento correspondiente en `docs/` y agregá una entrada en la sección `Sin publicar` de `CHANGELOG.md` dentro del mismo PR.

Respetá nuestro [Código de Conducta](CODE_OF_CONDUCT.md). ¿Dudas? Contactá al Responsable Técnico (**Facundo Nicolás González**) o abrí un Issue.
