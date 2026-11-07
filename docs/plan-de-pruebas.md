### Identificación del Proyecto

| Campo | Detalles |
| --- | --- |
| **Nombre del Proyecto** | Recetaria (Fase 1: MVP Backend API) |
| **Versión / Revisión** | 1.0.0 |
| **Fecha de Creación** | 07/11/2026 |
| **Estado** | Aprobado / En Implementación |
| **Responsable Técnico** | Facundo Nicolás González |
| **Responsable de QA** | Facundo Nicolás González |
| **Fecha de Última Revisión** | 07/11/2026 |
| **Recursos** | Trabajo práctico integrador, Thunder Client |

### 1. Objetivos principales

* Cumplir estrictamente con la rúbrica académica garantizando la entrega de pruebas funcionales exhaustivas mediante colección de Thunder Client (o capturas), cubriendo tanto casos de éxito como errores HTTP (400, 401, 404).


* Verificar sistemáticamente la validación de negocio y el control de acceso basado en roles (RBAC) asegurando que solo usuarios con permisos adecuados (CHEF, NUTRITIONIST) puedan alterar estados críticos de las recetas.
* Garantizar la operatividad del código con un bloque de manejo de errores integral (try/catch en cada controlador) y códigos de estado semánticos en cada respuesta (200, 201, 400, 401, 404, 500).



### 2. Niveles y estrategia de pruebas

Para el ciclo de desarrollo actual (MVP Backend), se adopta el modelo del "Testing Trophy" ajustado a las restricciones de entrega de 2 semanas. Se priorizan las pruebas de integración API y de aceptación.

| Nivel de Prueba | Esfuerzo Estimado | Enfoque Principal |
| --- | --- | --- |
| **Unitarias** | 20% | Validaciones de esquemas con Zod y reglas de negocio puras en la capa de Servicios. |
| **Integración** | 50% | Interacción entre Controladores, Middlewares (JWT/Roles) y la Base de Datos (PostgreSQL vía Prisma). |
| **Aceptación / API** | 30% | Colección de Thunder Client obligatoria para evaluar flujos completos de Endpoints tal cual los consume un cliente.

 |
| **Seguridad** | Transversal | Verificación de firmas JWT, exclusión de datos sensibles en el token y protección de rutas sensibles.

 |

**2.1. Pruebas unitarias**
Se centran en componentes de lógica aislada (Capa `Service`) para verificar su funcionamiento sin tocar la base de datos real.

* **Herramienta:** Vitest o Jest.
* **Alcance:** Funciones de transformación de datos (ej. cálculo de calorías del JSONB) y validación estricta de esquemas de entrada.
* **Convención:** Los archivos de prueba se ubican junto al código fuente de los servicios (ej. `recipes.service.test.ts`).

**2.2. Pruebas de integración**
Validan que los Middlewares intercepten correctamente (RBAC, Zod), los Controladores respondan, y los Repositorios escriban en PostgreSQL.

* **Herramientas:** Supertest + Vitest/Jest.
* **Entorno:** Base de datos relacional efímera ejecutada en un contenedor Docker, garantizando pruebas reales de persistencia y llaves foráneas.
* **Mocks:** Solo se falsean dependencias externas si existieran (ej. subida de imágenes a S3, que no aplica para el flujo crítico de esta fase).

**2.3. Pruebas de aceptación y API (Requisito TP)**
Verifican el cumplimiento exacto del contrato de la API estipulado en la consigna.

* **Objetivo:** Demostrar que los 5 endpoints del CRUD principal y los endpoints de Auth responden correctamente a peticiones reales.


* **Escenarios (Thunder Client):** Se debe documentar y exportar peticiones que fuercen errores deliberados: JWT inválido/inexistente (401), envío de un JSON mal formado (400) y búsqueda de UUID inexistente (404).



**2.4. Pruebas de seguridad**
Enfocadas en la protección de la integridad de los datos.

* **Gobernanza:** Asegurar que los secretos (JWT_SECRET, DATABASE_URL) nunca se expongan en los tests ni se suban al repositorio (uso estricto de `.env`).


* **Validación:** Probar iterativamente la intercepción del middleware: si un usuario `USER` lanza un `PUT /api/v1/recipes/:id/approve`, debe retornar `403 Forbidden`.

### 3. Stack tecnológico y herramientas

Dado que esta Fase 1 es exclusivamente Backend, las herramientas se seleccionan para auditar APIs REST.

| Ámbito | Herramienta Seleccionada | Propósito |
| --- | --- | --- |
| **Runner de Pruebas** | Jest / Vitest | Ejecución de aserciones unitarias e integración en Node.js. |
| **Backend API (Code)** | Supertest | Simulación programática de peticiones HTTP en memoria contra la app Express. |
| **Entrega / Aceptación** | Thunder Client | Exportación de colección de endpoints para evaluación docente.

 |
| **Frontend DOM / E2E** | *Fuera de alcance* | No aplica para Fase 1 MVP Backend. |
| **Carga / Stress** | K6 (Fase 2) | Scripting en JavaScript para inyectar carga sobre endpoints filtrados post-MVP. |

### 4. Criterios de éxito y calidad

La calidad del MVP se medirá en base al cumplimiento de la rúbrica del Bootcamp (100 puntos posibles) y la solidez arquitectónica.

* **Criterio de Entrega:** Todas las rutas que modifican datos (POST, PUT, DELETE) deben rechazar peticiones sin token JWT verificable.


* **Módulos Críticos:** 100% de cobertura de aserciones en los servicios de Autenticación (Bcrypt/JWT) y en al menos 2 validaciones de negocio exigidas.


* **Control de Estado:** El 100% de los controladores debe estar protegido por bloques `try/catch` manejando adecuadamente los status HTTP.


* **Registro Docente:** Exportación exitosa del archivo JSON de Thunder Client conteniendo los casos de prueba solicitados.



### 5. Gestión de riesgos en pruebas

Identificación proactiva de contingencias que puedan afectar el cronograma de 2 semanas de desarrollo.

* **Indisponibilidad o Corrupción de Entornos:** Las pruebas de mutación (POST/PUT/DELETE) pueden ensuciar la base de datos de desarrollo. *Mitigación:* Configuración de scripts de Prisma (`prisma migrate reset` o `tearDown` en Jest) para limpiar el entorno entre ejecuciones.
* **Retrasos en Desarrollo (Punto de control):** El punto de control al fin de la semana 1 exige el CRUD funcionando. *Mitigación:* Se priorizarán las pruebas del módulo `Recipes` antes de integrar el JWT.


* **Datos Sensibles en Entornos Públicos:** *Mitigación:* Uso de `.env.example` en el repositorio; el `.env` real debe estar en `.gitignore` para no filtrar contraseñas de bases de datos.



### 6. Aprobación del Plan

Este plan asegura la cobertura técnica y funcional requerida para la entrega exitosa del Proyecto Integrador.

**Firma líder de proyecto:** Facundo Nicolás González
**Fecha:** 07/11/2026
**Documentos de referencia:** ### Identificación del Proyecto

| Campo | Detalles |
| --- | --- |
| **Nombre del Proyecto** | Recetaria (Fase 1: MVP Backend API) |
| **Versión / Revisión** | 1.0.0 |
| **Fecha de Creación** | 07/11/2026 |
| **Estado** | Aprobado / En Implementación |
| **Responsable Técnico** | Facundo Nicolás González |
| **Responsable de QA** | Facundo Nicolás González |
| **Fecha de Última Revisión** | 07/11/2026 |
| **Recursos** | TP integrador - Tu propia API REST_1.pdf, Thunder Client |

### 1. Objetivos principales

* Cumplir estrictamente con la rúbrica académica garantizando la entrega de pruebas funcionales exhaustivas mediante colección de Thunder Client (o capturas), cubriendo tanto casos de éxito como errores HTTP (400, 401, 404).


* Verificar sistemáticamente la validación de negocio y el control de acceso basado en roles (RBAC) asegurando que solo usuarios con permisos adecuados (CHEF, NUTRITIONIST) puedan alterar estados críticos de las recetas.
* Garantizar la operatividad del código con un bloque de manejo de errores integral (try/catch en cada controlador) y códigos de estado semánticos en cada respuesta (200, 201, 400, 401, 404, 500).



### 2. Niveles y estrategia de pruebas

Para el ciclo de desarrollo actual (MVP Backend), se adopta el modelo del "Testing Trophy" ajustado a las restricciones de entrega de 2 semanas. Se priorizan las pruebas de integración API y de aceptación.

| Nivel de Prueba | Esfuerzo Estimado | Enfoque Principal |
| --- | --- | --- |
| **Unitarias** | 20% | Validaciones de esquemas con Zod y reglas de negocio puras en la capa de Servicios. |
| **Integración** | 50% | Interacción entre Controladores, Middlewares (JWT/Roles) y la Base de Datos (PostgreSQL vía Prisma). |
| **Aceptación / API** | 30% | Colección de Thunder Client obligatoria para evaluar flujos completos de Endpoints tal cual los consume un cliente.

 |
| **Seguridad** | Transversal | Verificación de firmas JWT, exclusión de datos sensibles en el token y protección de rutas sensibles.

 |

**2.1. Pruebas unitarias**
Se centran en componentes de lógica aislada (Capa `Service`) para verificar su funcionamiento sin tocar la base de datos real.

* **Herramienta:** Vitest o Jest.
* **Alcance:** Funciones de transformación de datos (ej. cálculo de calorías del JSONB) y validación estricta de esquemas de entrada.
* **Convención:** Los archivos de prueba se ubican junto al código fuente de los servicios (ej. `recipes.service.test.ts`).

**2.2. Pruebas de integración**
Validan que los Middlewares intercepten correctamente (RBAC, Zod), los Controladores respondan, y los Repositorios escriban en PostgreSQL.

* **Herramientas:** Supertest + Vitest/Jest.
* **Entorno:** Base de datos relacional efímera ejecutada en un contenedor Docker, garantizando pruebas reales de persistencia y llaves foráneas.
* **Mocks:** Solo se falsean dependencias externas si existieran (ej. subida de imágenes a S3, que no aplica para el flujo crítico de esta fase).

**2.3. Pruebas de aceptación y API (Requisito TP)**
Verifican el cumplimiento exacto del contrato de la API estipulado en la consigna.

* **Objetivo:** Demostrar que los 5 endpoints del CRUD principal y los endpoints de Auth responden correctamente a peticiones reales.


* **Escenarios (Thunder Client):** Se debe documentar y exportar peticiones que fuercen errores deliberados: JWT inválido/inexistente (401), envío de un JSON mal formado (400) y búsqueda de UUID inexistente (404).



**2.4. Pruebas de seguridad**
Enfocadas en la protección de la integridad de los datos.

* **Gobernanza:** Asegurar que los secretos (JWT_SECRET, DATABASE_URL) nunca se expongan en los tests ni se suban al repositorio (uso estricto de `.env`).


* **Validación:** Probar iterativamente la intercepción del middleware: si un usuario `USER` lanza un `PUT /api/v1/recipes/:id/approve`, debe retornar `403 Forbidden`.

### 3. Stack tecnológico y herramientas

Dado que esta Fase 1 es exclusivamente Backend, las herramientas se seleccionan para auditar APIs REST.

| Ámbito | Herramienta Seleccionada | Propósito |
| --- | --- | --- |
| **Runner de Pruebas** | Jest / Vitest | Ejecución de aserciones unitarias e integración en Node.js. |
| **Backend API (Code)** | Supertest | Simulación programática de peticiones HTTP en memoria contra la app Express. |
| **Entrega / Aceptación** | Thunder Client | Exportación de colección de endpoints para evaluación docente.

 |
| **Frontend DOM / E2E** | *Fuera de alcance* | No aplica para Fase 1 MVP Backend. |
| **Carga / Stress** | K6 (Fase 2) | Scripting en JavaScript para inyectar carga sobre endpoints filtrados post-MVP. |

### 4. Criterios de éxito y calidad

La calidad del MVP se medirá en base al cumplimiento de la rúbrica del Bootcamp (100 puntos posibles) y la solidez arquitectónica.

* **Criterio de Entrega:** Todas las rutas que modifican datos (POST, PUT, DELETE) deben rechazar peticiones sin token JWT verificable.


* **Módulos Críticos:** 100% de cobertura de aserciones en los servicios de Autenticación (Bcrypt/JWT) y en al menos 2 validaciones de negocio exigidas.


* **Control de Estado:** El 100% de los controladores debe estar protegido por bloques `try/catch` manejando adecuadamente los status HTTP.


* **Registro Docente:** Exportación exitosa del archivo JSON de Thunder Client conteniendo los casos de prueba solicitados.



### 5. Gestión de riesgos en pruebas

Identificación proactiva de contingencias que puedan afectar el cronograma de 2 semanas de desarrollo.

* **Indisponibilidad o Corrupción de Entornos:** Las pruebas de mutación (POST/PUT/DELETE) pueden ensuciar la base de datos de desarrollo. *Mitigación:* Configuración de scripts de Prisma (`prisma migrate reset` o `tearDown` en Jest) para limpiar el entorno entre ejecuciones.
* **Retrasos en Desarrollo (Punto de control):** El punto de control al fin de la semana 1 exige el CRUD funcionando. *Mitigación:* Se priorizarán las pruebas del módulo `Recipes` antes de integrar el JWT.


* **Datos Sensibles en Entornos Públicos:** *Mitigación:* Uso de `.env.example` en el repositorio; el `.env` real debe estar en `.gitignore` para no filtrar contraseñas de bases de datos.



### 6. Aprobación del Plan

Este plan asegura la cobertura técnica y funcional requerida para la entrega exitosa del Proyecto Integrador.

**Firma líder de proyecto:** Facundo Nicolás González
**Fecha:** 07/11/2026
**Documentos de referencia:** Trabajo práctico integrador