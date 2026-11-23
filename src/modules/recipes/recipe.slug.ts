import { randomBytes } from "node:crypto";

/** Longitud máxima del `slug` (`VARCHAR(200)`, `RN-01`). */
export const MAX_SLUG_LENGTH = 200;
export const SLUG_SUFFIX_LENGTH = 8;
/** Base máxima: 200 - 1 (guion separador) - 8 (sufijo hex) = 191. */
export const MAX_SLUG_BASE_LENGTH = MAX_SLUG_LENGTH - SLUG_SUFFIX_LENGTH - 1;
export const SLUG_FALLBACK_BASE = "receta";

const HEX_SUFFIX_PATTERN = /^[0-9a-f]{8}$/;
const COMBINING_MARKS_PATTERN = /\p{M}+/gu;
const NON_ALPHANUMERIC_PATTERN = /[^a-z0-9]+/g;
const EDGE_DASHES_PATTERN = /^-+|-+$/g;
const TRAILING_DASHES_PATTERN = /-+$/;

export type HexSuffixGenerator = () => string;

/** Sufijo aleatorio criptográfico de 8 caracteres hexadecimales. */
export const randomHexSuffix: HexSuffixGenerator = () => randomBytes(4).toString("hex");

/**
 * Normaliza un título a base ASCII en minúsculas (sin tildes ni `ñ`), con `-` como separador,
 * truncada a `MAX_SLUG_BASE_LENGTH` sin guion colgante y con fallback `"receta"`.
 */
export function normalizeSlugBase(title: string): string {
  const normalized = title
    .normalize("NFD")
    .replace(COMBINING_MARKS_PATTERN, "")
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_PATTERN, "-")
    .replace(EDGE_DASHES_PATTERN, "");

  const truncated = normalized.slice(0, MAX_SLUG_BASE_LENGTH).replace(TRAILING_DASHES_PATTERN, "");
  return truncated.length > 0 ? truncated : SLUG_FALLBACK_BASE;
}

/**
 * Genera el `slug` único de una receta en formato `<titulo-normalizado-ascii>-<8-hex>`
 * (≤ 200 caracteres, `RN-01`). Función pura salvo por el generador de sufijo inyectable.
 */
export function generateRecipeSlug(
  title: string,
  generateHexSuffix: HexSuffixGenerator = randomHexSuffix,
): string {
  const suffix = generateHexSuffix();
  if (!HEX_SUFFIX_PATTERN.test(suffix)) {
    throw new RangeError("El sufijo del slug debe tener 8 caracteres hexadecimales en minúsculas");
  }

  return `${normalizeSlugBase(title)}-${suffix}`;
}
