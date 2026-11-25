import type express from "express";
import { API_V1_PREFIX, type MountedRouter } from "../../src/app.js";

export type DiscoveredRoute = Readonly<{ method: string; path: string }>;

type RouteInfo = Readonly<{ path: string; methods: Readonly<Record<string, unknown>> }>;
type LayerInfo = Readonly<{
  slash: boolean;
  route: RouteInfo | undefined;
  handle: unknown;
  matchers: readonly ((path: string) => unknown)[];
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function toRouteInfo(value: unknown): RouteInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { path, methods } = value;
  if (typeof path !== "string" || !isRecord(methods)) {
    throw new Error("Capa de ruta de Express con forma inesperada: revisar la introspección");
  }
  return { path, methods };
}

/** Lee `stack` de un router de Express 5 sin `any` (API interna estable de `router@2`). */
function readStack(handle: unknown): readonly LayerInfo[] | undefined {
  if (typeof handle !== "function" && !isRecord(handle)) {
    return undefined;
  }
  const stack: unknown = Reflect.get(handle, "stack");
  if (!Array.isArray(stack)) {
    return undefined;
  }
  return stack.map((layer: unknown): LayerInfo => {
    if (!isRecord(layer)) {
      throw new Error("Capa de Express con forma inesperada: revisar la introspección");
    }
    const matchers = Array.isArray(layer.matchers)
      ? layer.matchers.filter((m: unknown): m is (path: string) => unknown => typeof m === "function")
      : [];
    return { slash: layer.slash === true, route: toRouteInfo(layer.route), handle: layer.handle, matchers };
  });
}

function routesOf(route: RouteInfo, prefix: string): DiscoveredRoute[] {
  return Object.entries(route.methods)
    .filter(([, enabled]) => enabled === true)
    .map(([method]) => {
      if (method === "_all") {
        throw new Error(`Ruta con router.all() no clasificable: ${prefix}${route.path}`);
      }
      return { method: method.toUpperCase(), path: `${prefix}${route.path === "/" ? "" : route.path}` || "/" };
    });
}

/** Rutas de un router de módulo montado en `prefix`; un sub-router anidado falla (no se descubriría). */
function discoverModuleRoutes(router: unknown, prefix: string): DiscoveredRoute[] {
  const stack = readStack(router);
  if (stack === undefined) {
    throw new Error(`El router montado en ${prefix} no expone stack`);
  }
  return stack.flatMap((layer) => {
    if (layer.route !== undefined) {
      return routesOf(layer.route, prefix);
    }
    if (readStack(layer.handle) !== undefined) {
      throw new Error(`Sub-router anidado en ${prefix}: ampliar el descubrimiento antes de agregarlo`);
    }
    if (!layer.slash) {
      throw new Error(`Handler montado con use(path) en ${prefix}: no es una ruta clasificable`);
    }
    return []; // middleware de router montado en "/" (sin ruta propia)
  });
}

/**
 * Descubre **todas** las rutas registradas en la app real (#22): rutas de nivel superior, routers
 * montados en la raíz (`/health`) y los routers de módulo bajo `API_V1_PREFIX`, identificados por
 * referencia con los `MountedRouter` que se pasaron a `buildApp`. Cualquier montaje que no sepa
 * clasificar hace fallar la prueba en lugar de omitirlo en silencio.
 */
export function discoverRoutes(app: express.Express, mounted: readonly MountedRouter[]): DiscoveredRoute[] {
  const appStack = readStack(Reflect.get(app, "router"));
  if (appStack === undefined) {
    throw new Error("La app no expone app.router.stack (¿cambió Express?)");
  }
  return appStack.flatMap((layer) => {
    if (layer.route !== undefined) {
      return routesOf(layer.route, "");
    }
    const children = readStack(layer.handle);
    if (children === undefined) {
      if (!layer.slash) {
        throw new Error("Handler montado con app.use(path, fn): responde sin ser una ruta clasificable");
      }
      return []; // middleware global montado en "/"
    }
    if (layer.slash) {
      return discoverModuleRoutes(layer.handle, "");
    }
    if (!layer.matchers.some((match) => Boolean(match(API_V1_PREFIX)))) {
      throw new Error("Router montado en un prefijo desconocido: ampliar el descubrimiento");
    }
    return children.flatMap((child) => {
      const entry = mounted.find((m) => m.router === child.handle);
      if (entry === undefined) {
        throw new Error(`Capa no reconocida bajo ${API_V1_PREFIX}: montar routers solo vía apiRouters`);
      }
      return discoverModuleRoutes(entry.router, `${API_V1_PREFIX}${entry.path}`);
    });
  });
}

export function routeKey(route: DiscoveredRoute): string {
  return `${route.method} ${route.path}`;
}
