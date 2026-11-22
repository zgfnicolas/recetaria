import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "../shared/errors/app-error.js";
import { sendError } from "../shared/http/jsend.js";
import { formatZodIssues } from "./validate.middleware.js";

export type ErrorLogger = (message: string, err: unknown) => void;

function hasErrorType(err: unknown): err is { readonly type: string } {
  return typeof err === "object" && err !== null && "type" in err && typeof err.type === "string";
}

function hasErrorCode(err: unknown): err is { readonly code: string } {
  return typeof err === "object" && err !== null && "code" in err && typeof err.code === "string";
}

/**
 * Crea el middleware global de errores de Express 5 (aridad estricta de 4 parámetros),
 * traduciendo fallos de parser, Zod 4, `AppError`, Prisma y errores inesperados a JSend.
 */
export function createErrorHandlerMiddleware(
  logError: ErrorLogger = console.error,
): ErrorRequestHandler {
  return (err: unknown, _req, res, next): void => {
    if (res.headersSent) {
      next(err);
      return;
    }

    if (hasErrorType(err) && err.type === "entity.parse.failed") {
      sendError(res, {
        statusCode: 400,
        message: "JSON inválido en el cuerpo de la solicitud",
      });
      return;
    }

    if (hasErrorType(err) && err.type === "request.aborted") {
      sendError(res, {
        statusCode: 400,
        message: "Solicitud interrumpida antes de completarse",
      });
      return;
    }

    if (
      hasErrorType(err) &&
      (err.type === "entity.too.large" || err.type === "parameters.too.many")
    ) {
      sendError(res, {
        statusCode: 413,
        message: "El cuerpo de la solicitud excede el tamaño máximo permitido",
      });
      return;
    }

    if (err instanceof ZodError) {
      sendError(res, {
        statusCode: 400,
        message: "Error de validación",
        errors: formatZodIssues(err.issues),
      });
      return;
    }

    if (err instanceof AppError) {
      if (!err.isOperational || err.statusCode === 500) {
        logError("[NON_OPERATIONAL_ERROR]", err);
        sendError(res, {
          statusCode: 500,
          message: "Error interno del servidor",
        });
        return;
      }

      sendError(res, {
        statusCode: err.statusCode,
        message: err.message,
        errors: err.errors,
      });
      return;
    }

    if (hasErrorCode(err) && err.code === "P2002") {
      sendError(res, {
        statusCode: 409,
        message: "Conflicto: el recurso ya existe",
      });
      return;
    }

    if (hasErrorCode(err) && err.code === "P2025") {
      sendError(res, {
        statusCode: 404,
        message: "Recurso no encontrado",
      });
      return;
    }

    logError("[UNHANDLED_ERROR]", err);
    sendError(res, {
      statusCode: 500,
      message: "Error interno del servidor",
    });
  };
}

/** Manejador global de errores por defecto sobre `console.error`. */
export const errorHandlerMiddleware: ErrorRequestHandler = createErrorHandlerMiddleware();
