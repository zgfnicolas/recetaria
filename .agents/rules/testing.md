---
trigger: glob
globs: "src/**/*.test.ts, src/**/*.spec.ts, tests/**/*.ts"
description: "Estrategia de pruebas unitarias, de integración con Supertest y colección Thunder Client."
---

# Reglas de Testing y QA

- Seguir el patrón **AAA** (*Arrange*, *Act*, *Assert*) en cada caso de prueba.
- **Pruebas unitarias (`*.service.test.ts`):** mockear exclusivamente el `Repository`; nunca mockear reglas internas del `Service` bajo prueba.
- **Pruebas de integración (`tests/`):** usar Supertest contra Express verificando validación Zod, JWT, RBAC, formato JSend y códigos HTTP (`200`, `201`, `400`, `401`, `403`, `404`, `409`).
- Citar el ID de regla de negocio en el nombre o descripción de tests críticos (ej. `RN-02`, `RN-05`, `RN-06`).
- Limpiar datos mutados entre suites (`afterEach` / `afterAll`) para evitar acoplamiento entre tests.
