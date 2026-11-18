# Roles y permisos

## Roles
| Rol | Quién es | Cómo obtiene el rol |
|---|---|---|
| Administrador (`ADMIN`) | Personal interno con control global y moderación | Asignado internamente en base de datos o por otro administrador |
| Nutricionista (`NUTRITIONIST`) | Profesional de la salud habilitado para auditar contenido nutricional | Alta controlada (en MVP mediante registro parametrizado; en Beta con validación KYC) |
| Chef (`CHEF`) | Profesional gastronómico habilitado para validar técnica y recetas | Alta controlada (en MVP mediante registro parametrizado; en Beta con validación KYC) |
| Usuario Final (`USER`) | Persona registrada que publica y gestiona sus recetas | Autoregistro en `POST /api/v1/auth/register` (rol por defecto) |
| Público (`Guest`) | Visitante sin sesión iniciada | Acceso anónimo sin token JWT |

## Matriz de permisos
| Acción | Admin | Nutricionista | Chef | Usuario | Público |
|---|:-:|:-:|:-:|:-:|:-:|
| Registrarse e iniciar sesión (`POST /api/v1/auth/*`) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Listar y ver detalle de recetas (`GET /api/v1/recipes*`) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Crear receta (`POST /api/v1/recipes`) | | ✓ | ✓ | ✓ | |
| Editar receta propia (`PUT /api/v1/recipes/:id`) | | ✓ | ✓ | ✓ | |
| Eliminar receta propia (`DELETE /api/v1/recipes/:id`) | ✓ | ✓ | ✓ | ✓ | |
| Eliminar cualquier receta (`DELETE /api/v1/recipes/:id`) | ✓ | | | | |
| Aprobar receta (`PUT /api/v1/recipes/:id/approve`) | | ✓ | ✓ | | |
| Auditar usuarios y logs internos (gestión administrativa) | ✓ | | | | |

## Reglas especiales
- **Propiedad en edición:** ningún usuario (incluidos `CHEF` y `NUTRITIONIST`) puede editar una receta cuyo `authorId` sea distinto al de su token (`recipe.authorId === req.user.id`).
- **Propiedad en borrado:** únicamente el autor original de la receta o un usuario con rol `ADMIN` pueden eliminarla.
- **Separación de funciones (RN-05):** un profesional (`CHEF` o `NUTRITIONIST`) no puede aprobar una receta que él mismo haya creado (`recipe.authorId !== req.user.id`).
- **Visibilidad pública:** los visitantes sin autenticación consultan el catálogo público de recetas aprobadas (`APPROVED`).
- **Rol en creación de cuenta:** aunque el esquema de registro del MVP permite seleccionar `USER`, `CHEF` o `NUTRITIONIST`, ningún usuario puede autoregistrarse como `ADMIN`.
