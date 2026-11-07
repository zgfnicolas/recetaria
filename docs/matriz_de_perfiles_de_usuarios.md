### Identificación del Proyecto

| Campo | Detalles |
| --- | --- |
| **Nombre del Proyecto** | Recetaria (Fase 1: MVP Backend API) |
| **Versión / Revisión** | 1.0.0 |
| **Fecha de Creación** | 06/11/2026 |
| **Estado** | En Revisión |
| **Responsable Técnico** | Facundo Nicolás González |
| **Responsable de Producto** | Facundo Nicolás González |

### 1. Matriz de perfiles de usuario (Roles)

Definición de los perfiles que operan en la plataforma según sus permisos y capacidades funcionales (RBAC).

| Perfil / Rol | Descripción Funcional | Nivel de Acceso | Requisitos / Conocimientos |
| --- | --- | --- | --- |
| **Usuario Público (Guest)** | Visitante que explora el contenido sin registro. | Lectura de recetas aprobadas (GET). | Navegación básica web/mobile. |
| **Usuario Final (USER)** | Persona registrada que busca, filtra y publica sus propias recetas. | Transaccional estándar (CRUD propio). | Autenticación JWT. Conocimiento básico de cocina. |
| **Profesional (CHEF / NUTRITIONIST)** | Experto que aporta recetas verificadas y audita el contenido generado por los usuarios. | Gestión propia + Aprobación de terceros (PUT status). | Título profesional (validado por Admin). Alta capacidad analítica de ingredientes. |
| **Administrador (ADMIN)** | Personal interno con control total de la plataforma y auditoría de profesionales. | Acceso total / ABM global. | Manejo de base de datos, logs de auditoría y gestión de credenciales. |

### 2. Ficha detallada de persona

**Persona 1: "El Buscador Saludable" (Usuario Final - USER)**

1. **Perfil Bio-Demográfico**
* **Arquetipo:** El entusiasta del bienestar.
* **Edad y Ubicación:** 20-45 años, áreas urbanas.
* **Ocupación Principal:** Estudiantes, oficinistas o personas con condiciones dietarias específicas (ej. celiaquía, fitness).


2. **Comportamiento digital (Contexto)**
* **Alfabetización Tecnológica:** Alta. Usa aplicaciones de delivery, macros y redes sociales constantemente.
* **Afinidad con IA:** Abierto a sugerencias algorítmicas para reemplazar ingredientes.
* **Dispositivos:** Principalmente móvil para cocinar con la pantalla encendida (Mobile-first UI).


3. **Objetivos y motivaciones**
* **Meta principal:** Encontrar una receta rápida, sabrosa y que respete estrictamente sus restricciones alimenticias o de tiempo.
* **Valor percibido:** Confianza ciega en que las recetas etiquetadas como "Apto Celíacos" están validadas y no son un riesgo para su salud.


4. **Puntos de dolor y frustraciones**
* **Barreras:** Motores de búsqueda ineficientes o blogs llenos de texto innecesario antes de llegar a los ingredientes.
* **Riesgos:** Desinformación nutricional que pueda desencadenar problemas de salud.

**Persona 2: "El Guardián del Contenido" (Profesional - NUTRITIONIST / CHEF)**

1. **Perfil Bio-Demográfico**
* **Arquetipo:** El educador con autoridad.
* **Edad y Ubicación:** 25-55 años.
* **Ocupación Principal:** Nutricionistas clínicos, deportólogos, chefs profesionales o estudiantes avanzados.


2. **Comportamiento digital (Contexto)**
* **Alfabetización Tecnológica:** Media-Alta. Acostumbrado a usar software de gestión de pacientes o inventario de cocina.
* **Afinidad con IA:** Moderada. Prefiere el control humano sobre las decisiones nutricionales críticas (Human-in-the-Loop).
* **Dispositivos:** Desktop o tablet para revisar detalladamente los valores nutricionales (JSONB) y redactar correcciones.


3. **Objetivos y motivaciones**
* **Meta principal:** Validar recetas para la comunidad, construir reputación digital como experto y captar potenciales pacientes/clientes.
* **Valor percibido:** Una plataforma que respeta su título y le da herramientas formales de auditoría, diferenciándolo de los "influencers" sin título.


4. **Puntos de dolor y frustraciones**
* **Barreras:** Flujos de revisión lentos, falta de estandarización en cómo los usuarios cargan las métricas (unidades, gramos).
* **Riesgos:** Aprobar accidentalmente una receta riesgosa por falta de claridad en la interfaz, comprometiendo su reputación profesional.

### 3. Ejemplo de Aplicación (Caso: Recetaria API)

| Atributo | Detalle de la Persona |
| --- | --- |
| **Nombre** | "El Buscador Saludable" (Usuario Final) |
| **Motivación** | Encontrar rápidamente una cena alta en proteínas y baja en carbohidratos filtrando por el campo `difficulty` y `tags`. |
| **Necesidad Técnica** | Endpoints de búsqueda (`GET /api/recipes`) con soporte de *query params* eficientes, estructurados bajo índices B-Tree en la base de datos PostgreSQL. |
| **Frustración** | Encontrar recetas con valores nutricionales vacíos o tiempos de preparación irreales. |

### 4. Alineación con requerimientos técnicos

Para satisfacer a estas personas y cumplir con el flujo del negocio, el sistema (API Node.js + Express) debe garantizar:

1. **Observabilidad y Trazabilidad:** Implementación de la tabla `AuditLog` para registrar exactamente qué Nutricionista o Chef modificó el estado de una receta (acción `APPROVE` o `REJECT`), garantizando transparencia.
2. **Seguridad (RBAC y Validación Estricta):** Protección perimetral en los endpoints mediante JWT y Middlewares de Roles. Uso de **Zod** para asegurar que los JSON de ingredientes ingresados por el Usuario Final vengan perfectamente estructurados antes de golpear la base de datos.
3. **Modularidad y Tipado Relacional:** Uso de PostgreSQL y Prisma para mantener una estructura rígida en las relaciones autor-receta, pero permitiendo flexibilidad con columnas `JSONB` para los metadatos nutricionales y listados dinámicos, preparando el terreno para las funcionalidades sociales de la Fase 2.

**Responsable del modelo:** Facundo Nicolás González
**Fecha de revisión:** 06/11/2026
**Documentos de referencia:** Trabajo práctico integrador