# Overrides de dependencias

Cada entrada de `overrides` en `package.json` debe figurar acá con motivo, dueño y condición de retiro.

| Paquete | Override | Motivo | Fecha | Dueño | Retirar cuando |
|---|---|---|---|---|---|
| `effect` | `^3.22.1` | `@prisma/config@7.10.1` fija `effect@3.20.0`, afectado por [GHSA-7589-6fvf-x4pw](https://github.com/advisories/GHSA-7589-6fvf-x4pw) (ReDoS en `Schema.TemplateLiteral`). Solo lo usa la CLI de Prisma (desarrollo/migraciones). | 2026-11-21 | Mantenedor del repo | Un patch de Prisma 7.x dependa de `effect >= 3.22.1`; luego quitar el override y verificar con `npm audit`. |

## Verificación
```bash
npm install && npm audit && npm run db:validate
```
