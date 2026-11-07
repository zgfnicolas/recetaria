---
description: Directivas y estándares para la suite de pruebas unitarias, de integración y QA en Recetaria API
globs: ["src/**/*.test.ts", "test/**/*.ts"]
---

# Reglas de Testing y QA

## 1. Estrategia de Testing (Testing Trophy)
1. **Pruebas Unitarias (Capa Service):**
   - Validan lógica de negocio pura y transformaciones de datos.
   - Ejecutadas con Vitest o Jest.
   - **Regla de Mocking:** Solo se falsea la capa inmediatamente inferior (`Repository`). Nunca se mockea la lógica interna del Servicio a evaluar.
2. **Pruebas de Integración (Capa HTTP / Controladores):**
   - Ejecutadas mediante Supertest invocando la aplicación Express.
   - Verifican que la cadena de Middlewares (`validateMiddleware`, `authMiddleware`, `rbacMiddleware`) actúe de forma correcta.
   - Se ejecutan contra una base de datos PostgreSQL de prueba (Docker efímero).
3. **Pruebas de Aceptación (Thunder Client):**
   - Colección exportada en `Thunder Client Collection.json`.
   - Cobertura obligatoria de los casos felices (200, 201) y casos de fallo deliberado (400, 401, 403, 404).

## 2. Estructura de las Pruebas (Patrón AAA)
Cada caso de prueba debe estructurarse claramente:
- **Arrange (Preparar):** Inicializar datos de entrada, stubs o mocks.
- **Act (Ejecutar):** Invocar el método del servicio o lanzar la petición HTTP.
- **Assert (Verificar):** Validar el código HTTP de respuesta, la estructura del sobre JSend y los datos persistidos.

## 3. Limpieza de Estado (TearDown)
- Ninguna prueba debe depender del orden de ejecución de otras pruebas.
- Limpiar o restaurar tablas de base de datos después de cada suite de mutación (`afterEach` o `afterAll`).
