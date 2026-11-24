/**
 * Utilidades puras de *entity tags* (RFC 9110 §8.8.3) para solicitudes condicionales `If-Match`.
 * Independientes de Express y del dominio.
 */

/** Etiqueta de entidad parseada; `weak` corresponde al prefijo `W/`. */
export type EntityTag = Readonly<{ opaque: string; weak: boolean }>;

/** Resultado del parseo de `If-Match`: ausente, comodín `*`, lista válida o sintaxis inválida. */
export type IfMatchHeader =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "any" }>
  | Readonly<{ kind: "tags"; tags: readonly EntityTag[] }>
  | Readonly<{ kind: "malformed" }>;

/** `entity-tag = [ "W/" ] DQUOTE *etagc DQUOTE` con `etagc = %x21 / %x23-7E` (sin `obs-text`). */
const ENTITY_TAG_PATTERN = /^(W\/)?"([\x21\x23-\x7E]*)"$/;
const MAX_IF_MATCH_LENGTH = 1024;

/** Formatea una etiqueta fuerte (`"<valor>"`); el valor no puede contener comillas ni espacios. */
export function formatStrongETag(value: string): string {
  if (!/^[\x21\x23-\x7E]+$/.test(value)) {
    throw new RangeError("El valor del ETag contiene caracteres no permitidos");
  }
  return `"${value}"`;
}

/**
 * Parsea el valor crudo de `If-Match` (Node une varios headers con `, `).
 * Rechaza listas vacías, elementos inválidos y valores desmedidos (OWASP API4).
 * Limitación conocida: separa por `,` sin interpretar comillas, así que no admite un opaco con
 * coma (`"a,b"`) ni los elementos vacíos que tolera la RFC (`"1", , "2"`). Ambos se tratan como
 * malformados; es suficiente para los ETags numéricos de Recetaria.
 */
export function parseIfMatch(raw: string | undefined): IfMatchHeader {
  if (raw === undefined || raw.trim() === "") {
    return { kind: "missing" };
  }
  if (raw.length > MAX_IF_MATCH_LENGTH) {
    return { kind: "malformed" };
  }
  const trimmed = raw.trim();
  if (trimmed === "*") {
    return { kind: "any" };
  }

  const tags: EntityTag[] = [];
  for (const element of trimmed.split(",")) {
    const candidate = element.trim();
    const match = ENTITY_TAG_PATTERN.exec(candidate);
    if (match === null) {
      return { kind: "malformed" };
    }
    tags.push({ opaque: match[2] ?? "", weak: match[1] !== undefined });
  }
  return { kind: "tags", tags };
}

/**
 * Comparación fuerte (RFC 9110 §8.8.3.2): coincide solo una etiqueta **no débil** con el mismo
 * valor opaco. `If-Match` exige comparación fuerte, así que un `W/"…"` nunca satisface.
 */
export function strongMatches(tags: readonly EntityTag[], currentOpaque: string): boolean {
  return tags.some((tag) => !tag.weak && tag.opaque === currentOpaque);
}
