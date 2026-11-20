# Patrones Pragmáticos y Control de Complejidad para Recetaria API

Referencia ejecutable de [pragmatic-engineering-complexity-control](../SKILL.md) 100 % en **TypeScript + Zod 4 + Prisma + PostgreSQL 15 + JSend**, alineada con [ADR-0005](../../../../docs/adr/0005-alcance-mvp-ciclo-recetas-y-auditoria.md) y `RN-01`–`RN-08`.

---

## 1. Matriz de triage de edge cases en TypeScript

Evaluar cada *"¿y qué pasa si...?"* por **origen, probabilidad, adversario, impacto, reversibilidad, detectabilidad, alcance y costo**:

```ts
// Ejemplo conceptual de triage explícito (deja visible qué eje dispara cada veredicto)
export const Verdict = {
  Cover: "cubrir en código",
  FailFast: "rechazar con error claro",
  Tripwire: "detectar + runbook",
  Ignore: "ignorar y documentar",
} as const;
export type Verdict = (typeof Verdict)[keyof typeof Verdict];

export type EdgeCaseInput = Readonly<{
  name: string;
  adversarial: boolean;     // ¿un atacante puede provocarlo a propósito?
  criticalImpact: boolean;  // seguridad, integridad de datos, permisos, auditoría
  irreversible: boolean;
  silent: boolean;          // ¿falla sin enterarse nadie?
  cheapToCover: boolean;    // CHECK, UNIQUE, 400 o pocas líneas
  rejectable: boolean;      // ¿rechazar es seguro y sin daño?
  observedInProd: boolean;
  plausible: boolean;
}>;

export function triageEdgeCase(c: EdgeCaseInput): readonly [Verdict, string] {
  if (c.adversarial && (c.criticalImpact || c.irreversible)) {
    return [Verdict.Cover, "provocable por un atacante con daño serio"];
  }
  if (c.criticalImpact && (c.irreversible || c.silent)) {
    return [Verdict.Cover, "daño crítico irreversible o silencioso"];
  }
  if (c.cheapToCover && (c.plausible || c.adversarial)) {
    return [Verdict.Cover, "cubrirlo cuesta menos que discutirlo"];
  }
  if (c.rejectable) {
    return [Verdict.FailFast, "rechazar es seguro y simple"];
  }
  if (c.plausible || c.observedInProd) {
    return [Verdict.Tripwire, "raro pero posible: medir antes de programar"];
  }
  return [Verdict.Ignore, "imposible por construcción o absurdo sin daño"];
}

// Caso real Recetaria: dos CHEFs aprueban simultáneamente la misma receta (RN-04/RN-06) => Verdict.Cover
```

---

## 2. Catálogo: qué se cubre siempre vs absurdos típicos

### 2.1 Se cubren siempre (parecen raros, no lo son)
| Caso en Recetaria API | Solución simple y robusta |
|---|---|
| Doble clic / carrera concurrente en `POST /recipes/:id/approve` | Update condicional atómico (`status = 'DRAFT'`) en `prisma.$transaction` → `409` |
| Fallo a mitad de `APPROVE`, `RESET_TO_DRAFT` o `DELETE` (`RN-06`) | `prisma.$transaction` envolviendo `recipes` + `audit_logs` |
| Usuario intentando editar/aprobar/borrar receta ajena o propia (`RN-02`–`RN-05`) | Autorización por objeto en `recipePolicy` + `rbacMiddleware` |
| Input vacío, fuera de rango (`prepTimeMinutes`), campos extra (BOPLA) o enorme | `z.strictObject(...)` en borde + `express.json({ limit: "100kb" })` |
| Unicode, tildes, mayúsculas en `email` o generación de `slug` | UTF-8 extremo a extremo, normalización al guardar y `UNIQUE` en PostgreSQL |
| Fechas y zonas horarias | `TIMESTAMPTZ` en UTC (`NOW()`) |
| Listas vacías y bordes de paginación | Tests de borde con orden determinístico `("createdAt" DESC, id DESC)` |
| Borrado de usuario con recetas o logs | FKs con `ON DELETE RESTRICT` / `SET NULL` (sin `CASCADE`) |

### 2.2 Absurdos típicos (no programar; a lo sumo documentar en 1 línea)
- *"¿Y si mañana cambiamos de PostgreSQL a otra base?"* → costo especulativo; detrás de `repository.ts` ya está aislado.
- *"¿Y si tenemos 10 millones de usuarios?"* en un MVP con 1 contenedor → diseñar por disparadores medidos.
- Revalidar dentro de `service.ts` o `repository.ts` lo que `z.strictObject` + TypeScript ya garantizaron en la frontera.
- Ramas de rescate para estados imposibles de una unión discriminada → usar `assertNever`.
- Hacer configurable vía JSON/BD una constante que nunca cambió sin deploy.

---

## 3. Frontera de confianza (*parse, don't validate*) vs sobre-defensa

```ts
// ✓ Frontera única con Zod 4: falla rápido (400 JSend) y entrega tipos exactos hacia adentro
import { z } from "zod";
import { ValidationError } from "../../shared/errors/app-error";

export const IngredientSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  quantity: z.number().positive(),
  unit: z.string().trim().min(1).max(30),
});

export type Ingredient = z.infer<typeof IngredientSchema>;

export function parseIngredients(raw: unknown): readonly Ingredient[] {
  const parsed = z.array(IngredientSchema).min(1).safeParse(raw);
  if (!parsed.success) throw new ValidationError("Ingredientes inválidos", parsed.error.flatten());
  return parsed.data;
}

// ✗ Sobre-defensa (esconde datos corruptos convirtiéndolos silenciosamente en 0):
// function totalQuantityBad(items?: { quantity?: number | string }[] | null): number {
//   if (!Array.isArray(items)) return 0;
//   return items.reduce((acc, item) => acc + (Number(item?.quantity) || 0), 0);
// }

// ✓ Interno: confía en el tipo validado en la frontera
export function totalQuantity(items: readonly Ingredient[]): number {
  return items.reduce((acc, item) => acc + item.quantity, 0);
}
```

---

## 4. Tripwires con vencimiento e intervención manual segura

### 4.1 `tripwire.ts` (medir antes de programar un caso raro)
```ts
// src/shared/observability/tripwire.ts
export const TRIPWIRE_REGISTRY = {
  slug_collision_retry_exceeded: {
    owner: "backend-recetaria",
    reviewBy: "2027-03-01",
    decisionIfSeen: "reemplazar sufijo corto de slug por estrategia determinística",
  },
} as const;

export type TripwireCase = keyof typeof TRIPWIRE_REGISTRY;

export function emitTripwire(caseName: TripwireCase, context: Readonly<Record<string, unknown>> = {}): void {
  const meta = TRIPWIRE_REGISTRY[caseName];
  // Incrementar métrica/counter si está instrumentado y emitir log estructurado
  console.warn(JSON.stringify({ event: "tripwire", case: caseName, owner: meta.owner, ...context }));
}
```
- **Regla de CI:** agregar un test unitario que falle si algún `reviewBy < hoy`, obligando a decidir: eliminar el tripwire (si nunca ocurrió) o programar la solución con datos reales.

### 4.2 Script de intervención manual seguro (`--dry-run` por defecto + transacción + auditoría)
Se elige intervención manual solo si hay: (1) detección automática por alerta/tripwire, (2) script revisado, idempotente, con `--dry-run` por defecto dentro de `prisma.$transaction`, (3) registro de actor/payload en `audit_logs` y (4) umbral de *toil* definido (si se corre más de N veces/mes, automatizar).

---

## 5. Plantilla de ADR de complejidad (`docs/adr/000N-...md`)

```markdown
# ADR-000N: <complejidad propuesta, ej. "Incorporar caché Redis en listado público">
- **Estado:** Propuesto | **Fecha:** YYYY-MM-DD | **Revisar el:** YYYY-MM-DD

## Problema actual (con evidencia)
Métricas reales, incidentes o requisito escrito (ej.: "p95 de GET /api/v1/recipes supera 400 ms con 50k recetas medidas en k6").

## Alternativas simples consideradas
1. Índice parcial en PostgreSQL (`WHERE status = 'APPROVED'`) — por qué alcanzó o no (con `EXPLAIN`).
2. Paginación keyset — impacto medido.

## Propuesta y costo
Qué se agrega, costo de construcción y mantenimiento recurrente (infra, monitoreo, invalidación, onboarding).

## Puerta de una o dos vías
Qué tan reversible es y cómo se deshace.

## Criterios de éxito y plan de salida
Métrica objetivo a verificar en la fecha de revisión y pasos para retirarlo si no cumple.
```

---

## 6. Señales medibles, frases de PR, antipatrones y DoD

### Señales de sobreingeniería vs sub-ingeniería
- **Sobreingeniería:** > 4–5 saltos/archivos para un endpoint simple sin transformación real · interfaces/factories con una sola implementación sin frontera ni test · configuraciones o feature flags inmóviles por meses · ramas de "rescate" nunca ejecutadas · tecnologías nuevas sin cuello de botella medido · aumento sostenido en *lead time* u onboarding.
- **Sub-ingeniería:** incidentes repetidos del mismo tipo · arreglos manuales frecuentes sin script/auditoría · corrupción silenciosa detectada tarde · cambios simples que rompen flujos lejanos · paths P0 sin tests.

### Frases útiles en PRs y refinamiento
- *Frenar sobreingeniería:* "¿Qué problema actual y medido resuelve esto?" · "Empecemos por la versión simple con un tripwire y revisamos si ocurre X" · "Esta interfaz tiene una sola implementación y no es una frontera: ¿la inlineamos hasta el segundo caso?" · "Si nunca cambió sin deploy, dejémoslo como constante."
- *Defender lo necesario:* "Lo puede provocar un atacante sobre permisos/auditoría: es un vector, no un caso borde" · "Si falla, corrompe datos en silencio: un `CHECK`/`UNIQUE` cuesta una línea" · "Cambiar esto después exige migrar datos en producción: es puerta de una vía, decidamos bien hoy."

### Antipatrones (`PR-01`–`PR-19`) y Definition of Done
- **Sobreingeniería:** `PR-01` abstracción sin frontera/2.º uso · `PR-02` *resume-driven development* · `PR-03` decisiones "por si acaso" sin disparador · `PR-04` capas pasamanos · `PR-05` configurar lo inmutable · `PR-06` generalizar al 1.er caso · `PR-07` rescate para imposibles · `PR-08` revalidar internamente lo tipado · `PR-09` *gold plating* · `PR-10` parálisis por casos sin adversario ni daño · `PR-11` sumar tecnología sin requisito.
- **Sub-ingeniería:** `PR-12` ignorar casos con adversario · `PR-13` sin idempotencia/atomicidad en reintentos/concurrencia · `PR-14` omitir constraints SQL "porque Zod valida" · `PR-15` aplicar YAGNI a puertas de una vía · `PR-16` arreglos manuales sin script ni auditoría · `PR-17` logs sin métrica/dueño/vencimiento · `PR-18` *fail fast* a mitad de mutación sin transacción · `PR-19` duplicar conocimiento de negocio en nombre de la regla de tres.
- **DoD:** toda complejidad nueva tiene evidencia (y ADR si es significativa) · casos de §2.1 cubiertos con la solución simple · edge cases discutidos con veredicto explícito · validación solo en frontera + tipos estrictos adentro · tripwires con dueño y fecha verificada en CI · arreglos manuales con `--dry-run`, transacción y auditoría · 0 abstracciones/flags muertos.
