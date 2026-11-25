# AGENTS.md

## Proyecto
Recetaria API — MVP Backend REST para publicar y validar recetas con control de acceso por roles (RBAC). Detalle del producto: `docs/prd.md`.

## Comandos
```bash
npm install          # dependencias
npm run docker:db    # PostgreSQL 15 en segundo plano
npm run dev          # servidor local en http://localhost:3000
npm run build        # compila TypeScript y valida tipos
npm test             # tests unitarios e integración
npm run docker:config # valida compose.yaml + compose.override.yaml
```
Corré `npm run build` y `npm test` antes de dar una tarea por terminada.

## Arquitectura en 4 capas
1. Transporte: `src/modules/*/router.ts` y `src/middlewares/` — rutas HTTP, validación Zod, JWT y RBAC
2. Controladores: `src/modules/*/controller.ts` — solo `req`/`res`, `try/catch` obligatorio y respuesta JSend
3. Negocio: `src/modules/*/service.ts` — toda la lógica de dominio y coordinación de transacciones
4. Persistencia: `src/modules/*/repository.ts` — único lugar que instancia o llama a Prisma Client

Una capa solo importa de la siguiente. Los servicios y controladores nunca llaman a Prisma directamente. Detalle: `docs/sad.md`.

## Dónde está cada cosa
- Glosario de dominio: @GLOSSARY.md
- Requisitos del producto: @docs/prd.md
- Reglas de negocio: @docs/business_rules.md
- Roles y permisos: @docs/roles.md
- Arquitectura y contrato JSend: @docs/sad.md
- Modelo de datos: @docs/data_model.md
- Esquema SQL inicial: @database_schema_init.sql
- Decisiones técnicas: `docs/adr/`
- Estrategia de pruebas: `docs/testing.md`

## Reglas inviolables
- Toda receta nueva inicia en `DRAFT` con `authorId` del token JWT (`RN-01`)
- Solo el autor (`recipe.authorId === req.user.id`) puede editar su receta (`RN-02`)
- Solo el autor o `ADMIN` pueden eliminar una receta (`RN-03`)
- Solo `CHEF` o `NUTRITIONIST` pueden aprobar recetas (`RN-04`) y no pueden auto-aprobar las propias (`RN-05`)
- Toda aprobación (`APPROVE`), reinicio por edición (`RESET_TO_DRAFT`) y borrado (`DELETE`) ejecuta actualización/borrado de `recipes` e inserción en `audit_logs` dentro de `prisma.$transaction` (`RN-06`)
- `prepTimeMinutes` entre `1` y `1440` y al menos un ingrediente en `ingredients`, todos con `quantity > 0` (`RN-07`); contraseñas con Bcrypt `>= 10` rounds (`RN-08`)
- La autorización usa siempre el rol y el estado **vigentes** del actor en la base, no los del JWT: un usuario inexistente o con `isActive = false` recibe `401` (`RN-08`, ADR-0009)
- Solo un `ADMIN` activo (revalidado con lock en la transacción) cambia el rol de **otro** usuario, nunca el propio ni dejando el sistema sin `ADMIN` activo, con `ROLE_CHANGED` en `audit_logs` dentro de `prisma.$transaction` (`RN-09`)
- Solo un `ADMIN` activo activa o desactiva la cuenta de **otro** usuario, nunca la propia ni al último `ADMIN` activo, con `ACCOUNT_ACTIVATED`/`ACCOUNT_DEACTIVATED` en `audit_logs` dentro de `prisma.$transaction` (`RN-10`)

## Convenciones
- TypeScript estricto: prohibido `any`; inferir DTOs con `z.infer<typeof schema>`
- Archivos de código en `kebab-case.ts`; clases e interfaces en `PascalCase`
- Contrato de respuesta JSend en todos los endpoints bajo `/api/v1`
- Commits con Conventional Commits (`feat(modulo): ...`, `fix(modulo): ...`); sugerir rama modular para cada feature o fix

## Límites
No hagas sin pedir confirmación humana explícita:
- Crear o modificar migraciones o esquemas de base de datos (`prisma migrate`, `db push`)
- Modificar `package.json` o instalar/quitar dependencias
- Borrar archivos o datos
- Tocar `.env`, `secrets/` o configuración de Docker/CI
- Ejecutar comandos de Git que alteren historial (`commit`, `push`, `reset`, `checkout`)

## Si algo no está claro
Si el pedido, el plan o las reglas se contradicen, o falta información, detenete y preguntá antes de escribir código. No supongas.

## Trabajo con planes
Si existe un plan activo en `docs/plans/`, ejecutá solo la fase indicada y detenete al terminarla para que se revise.
