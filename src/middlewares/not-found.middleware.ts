import type { RequestHandler } from "express";
import { NotFoundError } from "../shared/errors/app-error.js";

/**
 * Captura rutas inexistentes y delega un `NotFoundError` al manejador global de errores.
 * Usa `req.path` para evitar reflejar query strings en la respuesta JSend.
 */
export const notFoundMiddleware: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Ruta no encontrada: ${req.method} ${req.path}`));
};
