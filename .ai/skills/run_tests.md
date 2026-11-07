# Skill: Ejecución de Pruebas Automatizadas (`run_tests`)

| Metadata | Valor |
| :--- | :--- |
| **Identificador** | `skl_run_tests` |
| **Tipo** | Funcionalidad Atómica Ejecutable (Nivel 2) |
| **Herramientas Asociadas** | Vitest / Jest, Supertest, Thunder Client |
| **Estándar** | SKL-PRO-001 |

---

## 1. Propósito y Cuándo Usar

Instruir al agente de software sobre cómo ejecutar e interpretar suites de pruebas unitarias y de integración de manera determinista y segura en el entorno backend de Recetaria.

---

## 2. Comandos Operativos

```bash
# Ejecutar todas las pruebas unitarias y de integración
npm test

# Ejecutar pruebas en modo observador (watch) para desarrollo focalizado
npm run test:watch

# Ejecutar cobertura de pruebas
npm run test:coverage

# Ejecutar una prueba específica por archivo
npx vitest run src/modules/recipes/recipe.service.test.ts
```

---

## 3. Protocolo de Aislamiento y Resiliencia

1. **Base de Datos Efímera:** Las pruebas de integración que toquen la capa `Repository` deben ejecutarse contra una base de datos PostgreSQL de testing o mediante un contenedor Docker dedicado, nunca contra la base de datos de producción o desarrollo activa.
2. **Limpieza entre Ejecuciones (TearDown):** Cada suite de pruebas que realice inserciones (`POST`, `PUT`) debe restaurar o truncar las tablas al finalizar para evitar efectos secundarios (*test pollution*).
3. **Manejo de Fallos:** Si una prueba falla, el agente debe detenerse, aislar el fallo, inspeccionar el assertion error y no intentar modificar el código de producción sin justificar la causa raíz.
