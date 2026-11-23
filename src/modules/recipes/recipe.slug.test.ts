import { describe, expect, it } from "vitest";
import {
  generateRecipeSlug,
  MAX_SLUG_BASE_LENGTH,
  MAX_SLUG_LENGTH,
  normalizeSlugBase,
  SLUG_FALLBACK_BASE,
} from "./recipe.slug.js";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}$/;

describe("normalizeSlugBase (RN-01)", () => {
  it.each([
    ["Ñoquis de Papá", "noquis-de-papa"],
    ["Crème Brûlée à la Française", "creme-brulee-a-la-francaise"],
    ["Pingüino   helado!!", "pinguino-helado"],
    ["  --Tarta  de   ACELGA--  ", "tarta-de-acelga"],
    ["Pan 100% integral (v2)", "pan-100-integral-v2"],
  ])("normaliza %j a %j (minúsculas ASCII, sin tildes ni ñ)", (title, expected) => {
    // Act
    const base = normalizeSlugBase(title);

    // Assert
    expect(base).toBe(expected);
  });

  it.each(["🍕🍔", "!!!", "   ", "日本料理"])(
    "usa el fallback %j cuando el título no tiene caracteres ASCII alfanuméricos",
    (title) => {
      expect(normalizeSlugBase(title)).toBe(SLUG_FALLBACK_BASE);
    },
  );

  it("trunca a 191 caracteres sin dejar guion colgante", () => {
    // Arrange: el carácter 191 cae justo en un separador
    const title = `${"a".repeat(190)} ${"b".repeat(50)}`;

    // Act
    const base = normalizeSlugBase(title);

    // Assert
    expect(base).toBe("a".repeat(190));
    expect(base.length).toBeLessThanOrEqual(MAX_SLUG_BASE_LENGTH);
    expect(base.endsWith("-")).toBe(false);
  });
});

describe("generateRecipeSlug (RN-01)", () => {
  it("concatena la base normalizada con el sufijo hexadecimal inyectado", () => {
    expect(generateRecipeSlug("Ñoquis caseros", () => "0a1b2c3d")).toBe("noquis-caseros-0a1b2c3d");
  });

  it("genera por defecto un sufijo aleatorio de 8 hex con formato válido y sin colisiones triviales", () => {
    // Act
    const slugs = Array.from({ length: 50 }, () => generateRecipeSlug("Guiso de lentejas"));

    // Assert
    for (const slug of slugs) {
      expect(slug).toMatch(SLUG_PATTERN);
      expect(slug.startsWith("guiso-de-lentejas-")).toBe(true);
    }
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("nunca supera 200 caracteres con títulos muy largos", () => {
    // Act
    const slug = generateRecipeSlug("Receta ".repeat(80));

    // Assert
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug).toMatch(SLUG_PATTERN);
  });

  it.each(["", "ABCDEF12", "0a1b2c3", "0a1b2c3d4", "zzzzzzzz"])(
    "rechaza sufijos inválidos %j con RangeError",
    (suffix) => {
      expect(() => generateRecipeSlug("Tarta", () => suffix)).toThrow(RangeError);
    },
  );
});
