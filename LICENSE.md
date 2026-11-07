# 1. Licencia MIT

La licencia MIT sigue siendo el estándar de facto para la máxima interoperabilidad y simplicidad en proyectos de código abierto.

**Archivo: LICENSE**

Copyright (c) 2026 Facundo Nicolás González y colaboradores.

Se concede permiso, de forma gratuita, a cualquier persona que obtenga una copia de este software y de los archivos de documentación asociados (el "Software"), para utilizar el Software sin restricciones, incluyendo, sin limitación, los derechos de uso, copia, modificación, fusión, publicación, distribución, sublicencia y/o venta de copias del Software, y para permitir a las personas a las que se les proporcione el Software que lo hagan, sujeto a las siguientes condiciones:

El aviso de copyright anterior y este aviso de permiso se incluirán en todas las copias o partes sustanciales del Software.

EL SOFTWARE SE PROPORCIONA "TAL CUAL", SIN GARANTÍA DE NINGÚN TIPO, EXPRESA O IMPLÍCITA, INCLUYENDO, PERO NO LIMITADO A, GARANTÍAS DE COMERCIALIZACIÓN, ADECUACIÓN PARA UN PROPÓSITO PARTICULAR Y NO INFRACCIÓN. EN NINGÚN CASO LOS AUTORES O TITULARES DE LOS DERECHOS DE AUTOR SERÁN RESPONSABLES DE NINGUNA RECLAMACIÓN, DAÑOS U OTRA RESPONSABILIDAD, YA SEA EN UNA ACCIÓN DE CONTRATO, AGRAVIO O DE OTRO MODO, QUE SURJA DE, FUERA DE O EN CONEXIÓN CON EL SOFTWARE O EL USO U OTROS TRATOS EN EL SOFTWARE.

---

# 2. Plantilla de Licencia Apache 2.0

*Recomendada para proyectos de nivel empresarial o Cloud que requieren una concesión explícita de derechos de patente.*

**Archivo: LICENSE (Resumen Operativo)**

Para la implementación completa de la Licencia Apache 2.0 en su repositorio:
1. Incluya el texto íntegro disponible en la Apache Software Foundation.
2. Agregue el siguiente encabezado a cada archivo de origen:

Copyright 2026 Facundo Nicolás González

Licenciado bajo la Licencia Apache, Versión 2.0 (la "Licencia"); no puede utilizar este archivo excepto en cumplimiento con la Licencia. Puede obtener una copia de la Licencia en: http://www.apache.org/licenses/LICENSE-2.0.

A menos que lo exija la ley aplicable o se acuerde por escrito, el software distribuido bajo la Licencia se distribuye "TAL CUAL", SIN GARANTÍAS NI CONDICIONES DE NINGÚN TIPO, ya sean expresas o implícitas. Consulte la Licencia para conocer el lenguaje específico que rige los permisos y las limitaciones en virtud de la Licencia.

---

# 3. Gobernanza para Agentes de IA (Contexto)

De acuerdo con el Estándar de Documentación Híbrida, la licencia debe integrarse en la arquitectura de memoria del agente a través del archivo `AGENTS.md` o mediante metadatos para asegurar que los sistemas autónomos respeten los límites legales.

| Acción del Agente | Clasificación Estándar | Justificación Legal |
| :--- | :--- | :--- |
| **Generar documentación** | Siempre (Always) | Permitido bajo MIT/Apache como uso derivado. |
| **Modificar lógica de negocio** | Preguntar (Ask) | Asegura la autoría humana en cambios críticos. |
| **Publicar claves API** | Nunca (Never) | Violación de seguridad y términos de servicio. |
| **Entrenar modelos nuevos** | Preguntar (Ask) | Requiere verificación de cumplimiento ético y contractual. |

Esta estructura asegura que, incluso en procesos de "Contextual Retrieval", el agente comprenda que la información recuperada está sujeta a términos de uso específicos.