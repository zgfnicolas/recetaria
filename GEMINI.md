# Solo para Antigravity

- Para cambios en `src/modules/*/service.ts`, `src/middlewares/` o esquemas de base de datos, generá primero un plan con `/plan` y esperá aprobación.
- Si existe un plan activo en `docs/plans/`, ejecutá solo la fase indicada y detenete para revisión humana.
- Antes de cerrar un cambio en código, delegá la revisión arquitectónica en `@code-reviewer` y la auditoría RBAC/OWASP en `@security-auditor`.
- Para verificar casos HTTP (`200`, `201`, `400`, `401`, `403`, `404`, `409`) y pruebas, delegá en `@qa-tester`.
- Para explorar archivos o buscar referencias amplias en el código sin sobrecargar el contexto, usá el subagente integrado `research`.
