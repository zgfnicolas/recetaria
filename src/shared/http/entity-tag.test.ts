import { describe, expect, it } from "vitest";
import { formatStrongETag, parseIfMatch, strongMatches } from "./entity-tag.js";

describe("formatStrongETag", () => {
  it("envuelve el valor en comillas dobles (ETag fuerte)", () => {
    expect(formatStrongETag("3")).toBe('"3"');
  });

  it.each(['con"comilla', "con espacio", ""])("rechaza el valor %j", (value) => {
    expect(() => formatStrongETag(value)).toThrow(RangeError);
  });
});

describe("parseIfMatch — RFC 9110 §13.1.1", () => {
  it.each([undefined, "", "   "])("trata %j como ausente", (raw) => {
    expect(parseIfMatch(raw)).toEqual({ kind: "missing" });
  });

  it.each(["*", "  *  "])("reconoce el comodín %j", (raw) => {
    expect(parseIfMatch(raw)).toEqual({ kind: "any" });
  });

  it("parsea una etiqueta fuerte", () => {
    expect(parseIfMatch('"3"')).toEqual({ kind: "tags", tags: [{ opaque: "3", weak: false }] });
  });

  it("parsea una lista con espacios, etiquetas débiles y la unión de varios headers de Node", () => {
    expect(parseIfMatch(' "1" ,W/"2",  "abc-9" ')).toEqual({
      kind: "tags",
      tags: [
        { opaque: "1", weak: false },
        { opaque: "2", weak: true },
        { opaque: "abc-9", weak: false },
      ],
    });
  });

  it.each(["3", "'3'", '"3', '3"', '"3",', ',"3"', '"a b"', 'w/"3"', '"1", *', '"é"'])(
    "marca como malformado %j",
    (raw) => {
      expect(parseIfMatch(raw)).toEqual({ kind: "malformed" });
    },
  );

  it("marca como malformado un valor desmedido (OWASP API4)", () => {
    expect(parseIfMatch(`"${"1".repeat(1100)}"`)).toEqual({ kind: "malformed" });
  });
});

describe("strongMatches — comparación fuerte (RFC 9110 §8.8.3.2)", () => {
  it("coincide con una etiqueta fuerte del mismo valor", () => {
    expect(strongMatches([{ opaque: "3", weak: false }], "3")).toBe(true);
  });

  it("nunca coincide con una etiqueta débil, aunque el valor sea igual", () => {
    expect(strongMatches([{ opaque: "3", weak: true }], "3")).toBe(false);
  });

  it("coincide si alguna etiqueta de la lista coincide", () => {
    expect(
      strongMatches(
        [
          { opaque: "1", weak: false },
          { opaque: "3", weak: false },
        ],
        "3",
      ),
    ).toBe(true);
  });

  it("no coincide con valores distintos", () => {
    expect(strongMatches([{ opaque: "31", weak: false }], "3")).toBe(false);
  });
});
