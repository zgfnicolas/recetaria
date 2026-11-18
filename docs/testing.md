# Estrategia de pruebas y QA

## 1. Objetivos y enfoque
Adoptamos el modelo **Testing Trophy** priorizando pruebas de integración HTTP y aceptación en API para verificar la cadena completa `Router -> Zod -> Auth/RBAC -> Controller -> Service -> Repository -> PostgreSQL`.

| Nivel | Peso | Herramienta | Enfoque |
|---|:-:|---|---|
| **Unitarias** | 20 % | Vitest / Jest | Lógica pura de negocio en `*.service.ts` y validaciones Zod |
| **Integración** | 50 % | Supertest + PostgreSQL Docker | Endpoints reales, middlewares, transacciones `$transaction` y errores Prisma |
| **Aceptación / API** | 30 % | Thunder Client | Colección exportada cubriendo casos felices y errores HTTP obligatorios |

## 2. Convenciones de pruebas
- **Ubicación:** pruebas unitarias junto al archivo fuente (`recipe.service.test.ts`); pruebas de integración en `tests/`.
- **Patrón AAA:** cada test se organiza en *Arrange* (preparar), *Act* (ejecutar) y *Assert* (verificar código HTTP, sobre JSend y estado persistido).
- **Regla de mocking:** en tests unitarios de `Service` solo se mockea la capa inmediata inferior (`Repository`). Nunca se mockea lógica interna del servicio bajo prueba.
- **Aislamiento de datos:** las pruebas de integración corren contra una instancia PostgreSQL efímera en Docker con limpieza (`afterEach` / `afterAll`) para evitar contaminación entre suites.

## 3. Matriz de cobertura HTTP requerida
Todo módulo (`Auth`, `Recipes`) debe contar con pruebas verificando:

| Código | Escenario obligatorio |
|---|---|
| `200 OK` / `201 Created` | Flujo exitoso con payload válido y rol autorizado |
| `400 Bad Request` | Body inválido por Zod o parámetro `:id` sin formato UUIDv4 |
| `401 Unauthorized` | Ruta protegida sin header `Authorization: Bearer` o con token expirado/inválido |
| `403 Forbidden` | Usuario `USER` intentando aprobar (`RN-04`), no autor intentando editar (`RN-02`) o auto-aprobación (`RN-05`) |
| `404 Not Found` | Recurso inexistente por ID válido (`P2025`) |
| `409 Conflict` | Registro con email duplicado o `slug` repetido (`P2002`) |

## 4. Comandos
```bash
npm test                 # Ejecuta pruebas unitarias y de integración
npm run test:watch       # Modo observador durante desarrollo (cuando se configure el runner)
```

*(Nota: la suite automatizada en `package.json` se configurará en el setup inicial de `src/` y `tests/`).*
