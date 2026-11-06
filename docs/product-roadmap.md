Este es el Documento de Visión y Hoja de Ruta Tecnológica (Technology Roadmap) estructurado para **Recetaria**. Está diseñado para conectar tácticamente tu entrega académica inmediata con la visión a largo plazo de una plataforma SaaS escalable, asegurando que las decisiones arquitectónicas de hoy no generen deuda técnica mañana.

## Fase 1: MVP Académico (Semanas 1-2)

**Objetivo:** Validar la estructura relacional base y cumplir con los requisitos del TP Integrador garantizando un código limpio.

* **Arquitectura Técnica:** Monolito en Node.js con Express, Prisma ORM y PostgreSQL. Estructura por componentes (features) aislada con el patrón Repository para la base de datos.
* **Características del Producto:** CRUD completo de recetas, registro/login con JWT, asignación de roles base (`USER`, `CHEF`, `NUTRITIONIST`, `ADMIN`), y filtros de búsqueda por URL query.
* **Métricas de Control:** 100% de cobertura de validaciones de negocio en la capa de servicios usando Zod, 0% de errores de integridad referencial.
* **Riesgos y Mitigaciones:** El *scope creep* (añadir más funciones de las pedidas) es el mayor riesgo. Se mitiga implementando el campo `RecipeStatus` (Draft, Approved) pero sin desarrollar aún el panel de revisión complejo.

## Fase 2: Alfa (Crecimiento Estructural y Red Social)

**Objetivo:** Evolucionar el MVP hacia una plataforma interactiva enfocada en contenido generado por el usuario (UGC).

* **Arquitectura Técnica:** Integración de repositorios de almacenamiento de objetos (AWS S3) para archivos multimedia. Configuración de pipelines CI/CD (GitHub Actions) para automatizar el despliegue de la API.
* **Características del Producto:**
* **Módulo Social:** Desarrollo de los esquemas relacionales para Likes, Comentarios anidados, y sistema de Seguidores (relaciones N:M recursivas en la tabla de usuarios).
* **Multimedia:** Soporte para carga de *thumbnails* de recetas y videos cortos de preparación.


* **Métricas de Control:** Tiempo de latencia en la subida de imágenes < 2 segundos, cobertura de tests de integración > 80% en los endpoints sociales.
* **Alternativas de Enfoque:** En lugar de procesar imágenes pesadas en Node.js (lo cual bloquea el Event Loop), una alternativa superior es generar URLs pre-firmadas (Pre-signed URLs) desde el backend para que el cliente suba el archivo directamente a S3.

## Fase 3: Beta (Validación Profesional y Planificación)

**Objetivo:** Activar el diferencial central de Recetaria: la confianza clínica y gastronómica.

* **Arquitectura Técnica:** Procesamiento asíncrono para colas de auditoría documental, modelado avanzado de datos en JSONB para macros nutricionales.
* **Características del Producto:**
* **Módulo KYC (Know Your Customer) Profesional:** Endpoint seguro para que Chefs y Nutricionistas suban sus certificados/matrículas. Flujo interno para que un `ADMIN` valide y otorgue el rol definitivo.
* **Flujo de Revisión de Recetas:** Un usuario común solicita revisión de su receta; un Nutricionista la analiza, ajusta los tags de condiciones de salud (ej: Apto Celíacos, Diabéticos) y aprueba el cambio de estado.
* **Módulo de Planificación Dietaria:** Entidades de `MealPlans` (planes semanales) asociados a los perfiles de usuarios.


* **Riesgos y Mitigaciones:** Transacciones conflictivas al actualizar perfiles de salud complejos. Se mitiga utilizando transacciones atómicas (`$transaction` en Prisma) para revertir cambios si el cálculo de macros falla.

## Fase 4: Versión Final y Escala Empresarial

**Objetivo:** Preparar la infraestructura para alto tráfico, búsquedas indexables complejas y optimización de retención.

* **Arquitectura Técnica:** Migración selectiva de carga. Implementación de una capa de caché en memoria (Redis) y separación de instancias de base de datos.
* **Características del Producto:**
* **Feed Inteligente:** Línea de tiempo alimentada por las interacciones del usuario y dietas compartidas por los profesionales que sigue.
* **SEO y Accesibilidad:** Exposición de *slugs* de recetas optimizados, sitemaps dinámicos, y soporte para microformatos (Schema.org) en el frontend.


* **Alternativas de Enfoque:** Para la arquitectura, se puede evaluar la transición hacia microservicios solo si el equipo crece. Si el equipo se mantiene pequeño, la alternativa más inteligente es un **Monolito Modular** respaldado por réplicas de lectura de PostgreSQL (Read Replicas) para separar el tráfico pesado de consultas (usuarios buscando recetas) del tráfico transaccional (dar likes, publicar).

| Fase | Hito Principal | Evolución del Esquema de Datos | Infraestructura Principal |
| --- | --- | --- | --- |
| **1. MVP** | TP Aprobado | Relacional estricto, Enums, Zod | Local / Entorno Cloud Básico |
| **2. Alfa** | Interacción UGC | Tablas pivote (Follows, Likes) | Node.js + Almacenamiento S3 |
| **3. Beta** | Entorno Profesional | JSONB Nutricional, Logs de Auditoría | Colas asíncronas para revisión |
| **4. Escala** | Alto Tráfico | Índices compuestos avanzados | Redis Caché, CDN de imágenes |

