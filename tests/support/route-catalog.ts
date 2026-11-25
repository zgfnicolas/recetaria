/**
 * Catálogo declarado de **todas** las rutas de la API (#22), fuente única para las pruebas de
 * rutas privadas por defecto (#22) y de la colección Thunder Client (#23). Una ruta nueva hace
 * fallar ambas hasta que se clasifica aquí; el conjunto público es el de `docs/roles.md`.
 */
export const ROUTE_CATALOG: Readonly<Record<string, Readonly<{ public: boolean }>>> = {
  "GET /health": { public: true },
  "GET /health/ready": { public: true },
  "POST /api/v1/auth/register": { public: true },
  "POST /api/v1/auth/login": { public: true },
  "GET /api/v1/recipes": { public: true },
  "GET /api/v1/recipes/:id": { public: true },
  "GET /api/v1/recipes/mine": { public: false },
  "POST /api/v1/recipes": { public: false },
  "PUT /api/v1/recipes/:id": { public: false },
  "DELETE /api/v1/recipes/:id": { public: false },
  "PUT /api/v1/recipes/:id/approve": { public: false },
  "PATCH /api/v1/users/:id/role": { public: false },
  "PATCH /api/v1/users/:id/status": { public: false },
};
