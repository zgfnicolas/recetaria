# Roles y permisos

## Roles
| Rol | Quién es | Cómo obtiene el rol en el MVP |
|---|---|---|
| Administrador (`ADMIN`) | Operador interno con permiso global de moderación de borrado | Parámetro `role: "ADMIN"` en `/api/v1/auth/register` o usuario semilla (`admin@recetaria.com`) |
| Nutricionista (`NUTRITIONIST`) | Revisor profesional habilitado para validar y aprobar recetas | Parámetro `role: "NUTRITIONIST"` en `/api/v1/auth/register` o usuario semilla (`nutri@recetaria.com`) |
| Chef (`CHEF`) | Revisor profesional gastronómico habilitado para aprobar recetas | Parámetro `role: "CHEF"` en `/api/v1/auth/register` o usuario semilla (`chef@recetaria.com`) |
| Usuario Final (`USER`) | Persona registrada que publica y gestiona sus recetas | Autoregistro en `POST /api/v1/auth/register` (rol por defecto) o semilla (`user@recetaria.com`) |
| Visitante (`Guest`) | Persona sin sesión iniciada | Acceso anónimo sin token JWT |

*(Nota: en fases posteriores a la entrega del MVP, el otorgamiento de roles `CHEF`, `NUTRITIONIST` y `ADMIN` pasará a validación KYC por un administrador).*

## Matriz de permisos
| Acción | Admin | Nutricionista | Chef | Usuario | Visitante |
|---|:-:|:-:|:-:|:-:|:-:|
| Consultar salud del servicio (`GET /health`) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Registrarse e iniciar sesión (`POST /api/v1/auth/*`) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Listar y ver detalle de recetas (`GET /api/v1/recipes*`) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Crear receta (`POST /api/v1/recipes`) | ✓ | ✓ | ✓ | ✓ | |
| Editar receta propia (`PUT /api/v1/recipes/:id`) | ✓ | ✓ | ✓ | ✓ | |
| Eliminar receta propia (`DELETE /api/v1/recipes/:id`) | ✓ | ✓ | ✓ | ✓ | |
| Eliminar cualquier receta (`DELETE /api/v1/recipes/:id`) | ✓ | | | | |
| Aprobar receta de terceros (`PUT /api/v1/recipes/:id/approve`) | | ✓ | ✓ | | |

## Reglas especiales
- **Visibilidad en lecturas públicas (`GET /api/v1/recipes` y `GET /api/v1/recipes/:id`):** por defecto devuelven todas las recetas (`DRAFT` y `APPROVED`) para permitir verificar el CRUD completo sin requerir aprobación previa; aceptan filtros opcionales `?status=`, `?difficulty=` y `?authorId=`.
- **Propiedad exclusiva en edición (`RN-02`):** ningún usuario (ni siquiera `ADMIN`) puede editar una receta cuyo `authorId` no coincida con su `req.user.id`.
- **Permiso de borrado (`RN-03`):** únicamente el autor original (`recipe.authorId === req.user.id`) o un usuario con rol `ADMIN` pueden eliminar una receta.
- **Separación de funciones en aprobación (`RN-04` y `RN-05`):** solo `CHEF` o `NUTRITIONIST` pueden invocar `PUT /api/v1/recipes/:id/approve`, y nunca sobre una receta creada por ellos mismos (`recipe.authorId !== req.user.id`).
