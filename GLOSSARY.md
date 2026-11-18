# Recetaria

Dominio de publicación comunitaria y validación profesional de recetas gastronómicas y nutricionales.

## Actores y Roles

**Usuario (User)**
Persona registrada que busca, publica y gestiona sus propias recetas dentro de la plataforma.
_Avoid_: Cliente, cuenta, miembro

**Autor (Author)**
Usuario que creó una receta específica y conserva la titularidad exclusiva para editarla.
_Avoid_: Creador, dueño, propietario

**Revisor Profesional (Reviewer)**
Chef o Nutricionista habilitado para auditar y aprobar recetas de terceros, otorgándoles respaldo culinario o clínico.
_Avoid_: Validador, moderador, verificador

**Administrador (Admin)**
Operador interno con facultad de moderación para eliminar cualquier receta del catálogo.
_Avoid_: Superusuario, operador, moderador

**Visitante (Guest)**
Persona sin cuenta iniciada que consulta el catálogo público de recetas.
_Avoid_: Anónimo, lector

## Catálogo y Ciclo de Vida

**Receta (Recipe)**
Preparación culinaria publicada por un Autor con título, descripción, tiempo de preparación, dificultad e ingredientes estructurados.
_Avoid_: Plato, publicación, ítem

**Ingrediente (Ingredient)**
Insumo perteneciente a una Receta definido por un nombre, una cantidad positiva y una unidad de medida.
_Avoid_: Componente, insumo, elemento

**Borrador (Draft)**
Estado inicial de toda Receta recién creada o modificada tras haber sido aprobada, pendiente de validación profesional.
_Avoid_: Pendiente, sin publicar, en revisión

**Receta Aprobada (Approved Recipe)**
Receta validada por un Revisor Profesional distinto de su Autor, con marca de publicación y responsable asignado.
_Avoid_: Publicada, verificada, certificada

**Aprobación (Approval)**
Transición única de Borrador a Receta Aprobada ejecutada por un Revisor Profesional distinto del Autor.
_Avoid_: Validación, publicación, alta

**Reinicio a Borrador (Reset to Draft)**
Vuelta automática al estado Borrador cuando el Autor modifica una Receta Aprobada, anulando la firma profesional previa hasta una nueva Aprobación.
_Avoid_: Invalidación, despublicación, rechazo

## Trazabilidad

**Registro de Auditoría (Audit Log)**
Asiento histórico e inmutable que documenta cada Aprobación, Reinicio a Borrador o eliminación de una Receta junto con su responsable.
_Avoid_: Log de sistema, historial, bitácora
