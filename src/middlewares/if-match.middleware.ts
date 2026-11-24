import type { RequestHandler } from "express";
import { BadRequestError, PreconditionRequiredError } from "../shared/errors/app-error.js";
import { parseIfMatch, type EntityTag } from "../shared/http/entity-tag.js";

export const IF_MATCH_REQUIRED_MESSAGE = "Se requiere If-Match con el ETag de la versión revisada";
export const IF_MATCH_MALFORMED_MESSAGE = "If-Match debe contener ETags con formato válido";
export const IF_MATCH_SINGLE_TAG_MESSAGE =
  "If-Match debe contener un único ETag: el de la versión revisada";

export type RequireIfMatchOptions = Readonly<{
  /**
   * Exige exactamente un ETag. Con versiones correlativas, una lista (`"1","2",…`) equivaldría a
   * `*` y permitiría operar sin haber leído el recurso.
   */
  singleTag?: boolean | undefined;
}>;

/** Precondiciones HTTP validadas en el borde y disponibles para el controlador. */
export type RequestPreconditions = Readonly<{ ifMatch: readonly EntityTag[] }>;

declare global {
  namespace Express {
    interface Request {
      preconditions?: RequestPreconditions;
    }
  }
}

/**
 * Exige una solicitud condicional `If-Match` con ETags concretos (bloqueo optimista, #46), antes
 * de consultar la base: ausente/vacío o `*` → `428` (no identifica la versión revisada);
 * sintaxis inválida (o una lista si `singleTag`) → `400`. Deja las etiquetas parseadas en
 * `req.preconditions.ifMatch`.
 */
export function requireIfMatchMiddleware(options?: RequireIfMatchOptions): RequestHandler {
  const singleTag = options?.singleTag === true;
  return (req, _res, next) => {
    const header = parseIfMatch(req.get("if-match"));
    switch (header.kind) {
      case "missing":
      case "any":
        next(new PreconditionRequiredError(IF_MATCH_REQUIRED_MESSAGE));
        return;
      case "malformed":
        next(
          new BadRequestError("Error de validación", {
            errors: [{ field: "If-Match", message: IF_MATCH_MALFORMED_MESSAGE }],
          }),
        );
        return;
      case "tags":
        if (singleTag && header.tags.length !== 1) {
          next(
            new BadRequestError("Error de validación", {
              errors: [{ field: "If-Match", message: IF_MATCH_SINGLE_TAG_MESSAGE }],
            }),
          );
          return;
        }
        req.preconditions = { ifMatch: header.tags };
        next();
    }
  };
}
