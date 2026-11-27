import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FREE_PLAN_MAX_REQUESTS,
  PARTS_DIR,
  SOURCE_FILE,
  serialize,
  splitCollection,
  type Collection,
} from "../../scripts/thunder-client/split-collection.js";

/**
 * Partes de la colección para el plan gratuito de Thunder Client (máx. 50 pedidos por colección).
 * La colección completa (`docs/thunder-client-collection.json`) sigue siendo la fuente única: su
 * formato, cobertura y ejecución los verifica `thunder-client-collection.test.ts`. Aquí solo se
 * garantiza que las partes derivadas estén sincronizadas, entren en el límite y sean importables.
 */

const source = JSON.parse(readFileSync(SOURCE_FILE, "utf8")) as Collection;
const expected = splitCollection(source);
const committed = readdirSync(PARTS_DIR).filter((f) => f.endsWith(".json")).sort();

describe("Partes de la colección Thunder Client (docs/thunder-client/)", () => {
  it("los archivos versionados coinciden con la división regenerada (correr el script si falla)", () => {
    expect(committed).toEqual(expected.map((p) => p.fileName).sort());
    for (const { fileName, collection } of expected) {
      expect(readFileSync(path.join(PARTS_DIR, fileName), "utf8"), fileName).toBe(serialize(collection));
    }
  });

  it("cada parte entra en el límite del plan gratuito y, en orden, reproduce la colección completa", () => {
    expect(expected.length).toBeGreaterThan(1);
    for (const { collection } of expected) {
      expect(collection.requests.length).toBeLessThanOrEqual(FREE_PLAN_MAX_REQUESTS);
    }
    const strip = ({ _id, colId, containerId, ...rest }: Collection["requests"][number]): unknown => rest;
    const folderOrder = new Map(source.folders.map((f) => [f._id, f.sortNum]));
    const fullRunOrder = [...source.requests].sort(
      (a, b) => (folderOrder.get(a.containerId) ?? 0) - (folderOrder.get(b.containerId) ?? 0) || a.sortNum - b.sortNum,
    );
    expect(expected.flatMap((p) => p.collection.requests.map(strip))).toEqual(fullRunOrder.map(strip));
  });

  it("Thunder Client 3.2.7 las reconoce como exportación nativa y sus ids no chocan con la completa", () => {
    const sourceIds = new Set([source.collectionId, ...source.folders.map((f) => f._id), ...source.requests.map((r) => r._id)]);
    const seen = new Set<string>();
    for (const { collection } of expected) {
      // Misma condición que el proveedor de importación de la extensión (ver `ref`).
      expect(collection.clientName).toContain("Thunder Client");
      expect(collection.collectionName.length).toBeGreaterThan(0);
      expect(collection.version.length).toBeGreaterThan(0);
      expect(collection.ref.length).toBeGreaterThan(0);
      const ids = [collection.collectionId, ...collection.folders.map((f) => f._id), ...collection.requests.map((r) => r._id)];
      for (const id of ids) {
        expect(sourceIds.has(id) || seen.has(id), id).toBe(false);
        seen.add(id);
      }
      for (const req of collection.requests) {
        expect(req.colId).toBe(collection.collectionId);
        expect(collection.folders.some((f) => f._id === req.containerId)).toBe(true);
      }
    }
  });
});
