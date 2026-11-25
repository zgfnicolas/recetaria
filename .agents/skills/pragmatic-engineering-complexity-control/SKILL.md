---
name: pragmatic-engineering-complexity-control
description: >-
  Evita sobreingeniería y casos borde absurdos sin caer en sub-ingeniería en Recetaria API
  (Node.js, Express 5, TypeScript 7, Zod 4, Prisma, PostgreSQL 15) — YAGNI, KISS, complejidad
  esencial vs accidental, regla de tres, puertas de una vs dos vías, matriz de triage de
  edge cases, fronteras de confianza y fail fast, tripwires con vencimiento, intervención
  manual con dry-run, ADR de complejidad en docs/adr/, señales medibles y frases de PR.
  Usar al diseñar features, revisar PRs, evaluar abstracciones o discutir casos borde.
---

# Ingeniería Pragmática y Control de Complejidad (Recetaria API)

**Objetivo:** construir la solución más simple que cumple los requisitos reales de **Recetaria API** ([prd.md](../../../docs/prd.md), [ADR-0005](../../../docs/adr/0005-alcance-mvp-ciclo-recetas-y-auditoria.md)) y deja abierto el cambio futuro. La complejidad es un costo que se paga todos los días: aceptala **solo con evidencia**.
**Prioridades:** Correctitud de datos y seguridad (no negociables) → Valor entregado hoy → Facilidad de cambio → Simplicidad → Rendimiento según evidencia → Generalidad.

## 0. Modo de trabajo y reglas duras (MUST)

Antes de aprobar una capa, patrón, librería o caso borde, relevá: **propuesta**, **origen** (requisito escrito, incidente real, métrica o hipótesis), **dominio** (crítico vs normal), **escala actual** (no la soñada) y **reversibilidad**.

**Formato de entrega:**
- **Veredicto explícito:** `hacer ahora` · `versión mínima ahora + tripwire` · `diferir con disparador medible` · `no hacer`.
- **Justificación** en 3–5 líneas indicando el eje decisivo (§2).
- Si se adopta complejidad significativa → **ADR de complejidad** en `docs/adr/` con evidencia, costo, plan de salida y fecha de revisión; si se difiere → disparador medible y dónde se vigila.

**Reglas duras:**
1. Toda complejidad nueva nombra el problema **actual** que resuelve y su evidencia (métrica, incidente o requisito escrito).
2. Lo **no negociable** se cubre siempre, aunque parezca poco frecuente: seguridad/autorización (`RN-02`–`RN-05`, `RN-08`), integridad de datos (`RN-01`, `RN-06`, `RN-07`), constraints `UNIQUE`/`CHECK`/FK e idempotencia/concurrencia.
3. La probabilidad de un caso con **adversario** se evalúa como la de un atacante, nunca como la de un usuario normal.
4. Validá en la **frontera de confianza** (`validateMiddleware` + `z.strictObject`); adentro confiá en los tipos estrictos e invariantes (`assertNever` / excepciones), sin código de rescate.
5. Ante datos inesperados, rechazá con un error claro (**fail fast**: `400`/`409` en JSend) antes que adivinar o silenciar.

## 1. Principios y puertas de una vía vs dos vías

- **Principios operativos:** *YAGNI* (no programar "por si acaso" sin disparador) · *KISS* · *complejidad esencial vs accidental* (no simplificar reglas reales `RN-01`–`RN-10`, sí eliminar capas vacías) · *regla de tres* (abstraer al 3.er uso real, pero centralizar conocimiento de negocio desde el 1.er duplicado) · *abstracción equivocada* (duplicar es más barato que mantener una mala abstracción) · *tecnología aburrida* (PostgreSQL + Express + Prisma antes de sumar Redis/colas sin métrica) · *último momento responsable*.

| Puerta de **dos vías** *(decidir simple hoy)* | Puerta de **una vía** *(invertir diseño ahora)* |
|---|---|
| Estructura interna de carpetas/módulos y nivel L1 vs L2 | Esquema PostgreSQL persistido, PKs (`UUID`) y FKs sin `CASCADE` |
| Librería interna o helpers de un módulo | Contrato público `/api/v1` y sobre JSend ([sad.md](../../../docs/sad.md)) |
| Caché externa, colas, réplicas o extracción de servicios | Modelo de permisos RBAC/ownership (`RN-02`–`RN-05`) y `audit_logs` (`RN-06`) |
| Flags o parámetros de despliegue | Representación de fechas (`TIMESTAMPTZ` UTC), UTF-8 y privacidad de datos |

## 2. Triage de edge cases y filtro previo (7 preguntas)

| Veredicto | Cuándo aplicarlo | Cómo resolverlo |
|---|---|---|
| **Cubrir en código** | Adversario, integridad/seguridad, irreversible, falla silenciosa o barato de cubrir | `CHECK`/`UNIQUE`/FK, Zod en borde, `prisma.$transaction`, update condicional |
| **Fail fast** | Dato inválido o estado inesperado sin daño al rechazar | `400`/`409` JSend claro + log estructurado |
| **Tripwire + runbook** | Raro, detectable, reversible y de daño acotado | Métrica + alerta + vencimiento (`reviewBy`) + script con `--dry-run` |
| **Ignorar y documentar** | Absurdo o imposible por construcción, sin adversario ni daño | Una línea en ADR o comentario; cero código |

**Filtro secuencial antes de escribir código:** (1) ¿Qué problema actual y medido resuelve? (2) ¿Es puerta de una vía? (3) ¿Cuál es la solución más simple que funciona hoy? (4) ¿Qué veredicto da la matriz de triage? (5) ¿La abstracción cuesta menos que duplicar? (6) ¿Alguien nuevo lo entiende en 10 minutos? (7) ¿Qué disparador medible haría revisar esta decisión?

## 3. Colaboración y delegación *(esta skill decide cuánto; las otras dicen cómo)*

| Necesidad | Skill |
|---|---|
| Nivel L0/L1 vs L2 y fronteras en 4 capas | [layered-architecture-ts](../layered-architecture-ts/SKILL.md) |
| Tipado fuerte TS 7, `assertNever`, regla de tres y límites de complejidad | [typescript-engineering](../typescript-engineering/SKILL.md) |
| Alcance MVP vs evolución Express 5 y *fail fast* JSend | [express-backend-engineering](../express-backend-engineering/SKILL.md) · [api-engineering-ts](../api-engineering-ts/SKILL.md) |
| Casos con adversario (BOLA/BFLA, JWT, anti-enumeración) | [identity-sessions-authorization](../identity-sessions-authorization/SKILL.md) |
| Puertas de una vía en datos (constraints, locks, `prisma.$transaction`) | [sql-relational-design](../sql-relational-design/SKILL.md) · [postgresql-engineering](../postgresql-engineering/SKILL.md) · [orm-persistence-js-ts](../orm-persistence-js-ts/SKILL.md) |
| Qué testear (P0/P1) vs qué cubre el tipado estático | [critical-path-testing](../critical-path-testing/SKILL.md) |
| Registro de ADRs en `docs/adr/` y glosario | [domain-modeling](../domain-modeling/SKILL.md) |

Para `triageEdgeCase()` en TypeScript, catálogo completo de casos obligatorios vs absurdos, fronteras Zod 4 (*sobre-defensa vs frontera*), `tripwire.ts`, script operativo seguro con `--dry-run`, plantilla de **ADR de complejidad**, señales medibles, frases para PRs, antipatrones (`PR-01`–`PR-19`) y **Definition of Done**, consultá [references/pragmatic-patterns.md](./references/pragmatic-patterns.md).
