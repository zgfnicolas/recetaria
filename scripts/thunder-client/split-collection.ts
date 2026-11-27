/**
 * Divide `docs/thunder-client-collection.json` (fuente única) en partes importables en el plan
 * gratuito de Thunder Client, que no ejecuta colecciones con más de 50 pedidos (ni siquiera una
 * carpeta suelta: el límite cuenta la colección entera).
 *
 * - Agrupa carpetas **completas** y en orden de *Run All* (nunca parte una carpeta), así que
 *   ejecutar las partes en orden equivale a ejecutar la colección completa: los tokens, ids y
 *   `ETag` viajan entre partes por el entorno activo.
 * - Deriva ids nuevos y deterministas (UUIDv5) para que importar las partes no pise la colección
 *   completa si ya estaba importada.
 *
 * Uso: `npx tsx scripts/thunder-client/split-collection.ts` (regenera `docs/thunder-client/`).
 * `tests/docs/thunder-client-parts.test.ts` falla si las partes quedan desincronizadas.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Límite de pedidos por colección del plan gratuito de Thunder Client 3.2.7. */
export const FREE_PLAN_MAX_REQUESTS = 50;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SOURCE_FILE = path.join(ROOT, "docs/thunder-client-collection.json");
export const PARTS_DIR = path.join(ROOT, "docs/thunder-client");

/** Espacio de nombres fijo para los UUIDv5 derivados (no cambiarlo: regeneraría todos los ids). */
const NAMESPACE = "5d0b2c6e-6f2a-4a51-9a3e-2b7c1f4e8d10";

export interface Folder {
  _id: string;
  name: string;
  containerId: string;
  created: string;
  sortNum: number;
}

export interface CollectionRequest {
  _id: string;
  colId: string;
  containerId: string;
  sortNum: number;
  [key: string]: unknown;
}

export interface Collection {
  clientName: string;
  collectionName: string;
  collectionId: string;
  dateExported: string;
  version: string;
  ref: string;
  folders: Folder[];
  requests: CollectionRequest[];
}

export interface CollectionPart {
  fileName: string;
  collection: Collection;
}

function uuidV5(name: string): string {
  const namespace = Buffer.from(NAMESPACE.replaceAll("-", ""), "hex");
  const bytes = createHash("sha1").update(namespace).update(name, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Agrupa carpetas completas, en orden, en partes de a lo sumo `maxRequests` pedidos. */
export function splitCollection(source: Collection, maxRequests = FREE_PLAN_MAX_REQUESTS): CollectionPart[] {
  const folders = [...source.folders].sort((a, b) => a.sortNum - b.sortNum);
  const requestsOf = (folder: Folder): CollectionRequest[] =>
    source.requests.filter((r) => r.containerId === folder._id).sort((a, b) => a.sortNum - b.sortNum);

  const orphans = source.requests.filter((r) => !folders.some((f) => f._id === r.containerId));
  if (orphans.length > 0) {
    throw new Error(`Hay ${orphans.length} pedido(s) fuera de una carpeta; no se pueden repartir en partes.`);
  }

  const groups: Folder[][] = [];
  let current: Folder[] = [];
  let count = 0;
  for (const folder of folders) {
    const size = requestsOf(folder).length;
    if (size > maxRequests) {
      throw new Error(`La carpeta "${folder.name}" tiene ${size} pedidos (> ${maxRequests}): dividila.`);
    }
    if (count + size > maxRequests && current.length > 0) {
      groups.push(current);
      current = [];
      count = 0;
    }
    current.push(folder);
    count += size;
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group, index) => {
    const n = index + 1;
    const collectionId = uuidV5(`${source.collectionId}/part-${n}`);
    const folderId = (folder: Folder): string => uuidV5(`${collectionId}/folder/${folder._id}`);
    return {
      fileName: `recetaria-parte-${n}-de-${groups.length}.json`,
      collection: {
        clientName: source.clientName,
        collectionName: `${source.collectionName} (parte ${n} de ${groups.length})`,
        collectionId,
        dateExported: source.dateExported,
        version: source.version,
        ref: `${source.ref}p${n}`,
        folders: group.map((folder) => ({ ...folder, _id: folderId(folder) })),
        requests: group.flatMap((folder) =>
          requestsOf(folder).map((req) => ({
            ...req,
            _id: uuidV5(`${collectionId}/request/${req._id}`),
            colId: collectionId,
            containerId: folderId(folder),
          })),
        ),
      },
    };
  });
}

export function serialize(collection: Collection): string {
  return `${JSON.stringify(collection, null, 2)}\n`;
}

function main(): void {
  const source = JSON.parse(readFileSync(SOURCE_FILE, "utf8")) as Collection;
  const parts = splitCollection(source);
  mkdirSync(PARTS_DIR, { recursive: true });
  for (const { fileName, collection } of parts) {
    writeFileSync(path.join(PARTS_DIR, fileName), serialize(collection));
    const folderNames = collection.folders.map((f) => f.name).join(", ");
    console.log(`${fileName}: ${collection.requests.length} pedidos — ${folderNames}`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
