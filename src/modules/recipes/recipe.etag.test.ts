import { describe, expect, it } from "vitest";
import { formatRecipeETag, toRecipeVersions } from "./recipe.etag.js";

describe("formatRecipeETag", () => {
  it.each([
    [1, '"1"'],
    [42, '"42"'],
  ])("formatea la versión %d como %s", (version, expected) => {
    expect(formatRecipeETag(version)).toBe(expected);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("rechaza la versión inválida %d", (version) => {
    expect(() => formatRecipeETag(version)).toThrow(RangeError);
  });
});

describe("toRecipeVersions", () => {
  it("convierte etiquetas fuertes numéricas e ignora débiles y opacas no numéricas", () => {
    expect(
      toRecipeVersions([
        { opaque: "3", weak: false },
        { opaque: "4", weak: true },
        { opaque: "abc", weak: false },
        { opaque: "07", weak: false },
        { opaque: "0", weak: false },
        { opaque: "12", weak: false },
      ]),
    ).toEqual([3, 12]);
  });

  it("ignora versiones fuera del rango seguro", () => {
    expect(toRecipeVersions([{ opaque: "9".repeat(20), weak: false }])).toEqual([]);
  });
});
