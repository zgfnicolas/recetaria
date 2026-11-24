import { formatStrongETag, type EntityTag } from "../../shared/http/entity-tag.js";

const RECIPE_VERSION_PATTERN = /^[1-9]\d*$/;

/** `ETag` fuerte de una Receta a partir de su versión de contenido (`"3"`, #46). */
export function formatRecipeETag(version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RangeError("La versión de la receta debe ser un entero >= 1");
  }
  return formatStrongETag(String(version));
}

/**
 * Versiones aceptadas por un `If-Match` (comparación fuerte, RFC 9110 §8.8.3.2): ignora las
 * etiquetas débiles (`W/"…"`) y las opacas que no son una versión válida, porque nunca coinciden.
 */
export function toRecipeVersions(tags: readonly EntityTag[]): number[] {
  return tags
    .filter((tag) => !tag.weak && RECIPE_VERSION_PATTERN.test(tag.opaque))
    .map((tag) => Number(tag.opaque))
    .filter((version) => Number.isSafeInteger(version));
}
