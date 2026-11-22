import type { Request, RequestHandler } from "express";
import type { z } from "zod";
import { BadRequestError, type ErrorDetail } from "../shared/errors/app-error.js";

export type ValidationSection = "body" | "query" | "params";

export type ValidatedRequestData<
  TBody = unknown,
  TQuery = unknown,
  TParams = unknown,
> = {
  body?: TBody;
  query?: TQuery;
  params?: TParams;
};

/**
 * Tipo auxiliar para controladores posteriores a `validateMiddleware`,
 * estrechando `req.valid` sin usar `any`.
 */
export type ValidatedRequest<
  TBody = unknown,
  TQuery = unknown,
  TParams = unknown,
> = Request & {
  readonly valid: ValidatedRequestData<TBody, TQuery, TParams>;
};

declare global {
  namespace Express {
    interface Request {
      valid?: ValidatedRequestData;
    }
  }
}

export type ValidationSchemas = Readonly<{
  body?: z.ZodType | undefined;
  query?: z.ZodType | undefined;
  params?: z.ZodType | undefined;
}>;

type SectionReader = Readonly<{
  section: ValidationSection;
  read: (req: Request) => unknown;
}>;

const VALIDATION_SECTIONS: readonly SectionReader[] = [
  { section: "params", read: (req) => req.params },
  { section: "query", read: (req) => req.query },
  { section: "body", read: (req) => req.body ?? {} },
];

/**
 * Convierte los *issues* de Zod 4 en detalles `{ field, message }` para el sobre JSend.
 * Expande claves rechazadas de `z.strictObject` (`unrecognized_keys`) para visibilidad BOPLA.
 */
export function formatZodIssues(
  issues: readonly z.core.$ZodIssue[],
  fallbackField: ValidationSection | "request" = "request",
): ErrorDetail[] {
  const details: ErrorDetail[] = [];

  for (const issue of issues) {
    const basePath = issue.path.map((segment) => String(segment)).join(".");

    if (issue.code === "unrecognized_keys" && issue.keys.length > 0) {
      for (const key of issue.keys) {
        details.push({
          field: basePath.length > 0 ? `${basePath}.${key}` : key,
          message: "Campo no permitido",
        });
      }
      continue;
    }

    details.push({
      field: basePath.length > 0 ? basePath : fallbackField,
      message: issue.message,
    });
  }

  return details;
}

/**
 * Valida `params`, `query` y `body` con esquemas Zod 4 y guarda el resultado limpio en `req.valid`
 * sin mutar ni reasignar el getter `req.query` de Express 5.
 */
export function validateMiddleware(schemas: ValidationSchemas): RequestHandler {
  return (req, _res, next) => {
    const errors: ErrorDetail[] = [];
    const nextValid: ValidatedRequestData = {};

    for (const { section, read } of VALIDATION_SECTIONS) {
      const schema = schemas[section];
      if (schema === undefined) {
        if (req.valid?.[section] !== undefined) {
          nextValid[section] = req.valid[section];
        }
        continue;
      }

      const parsed = schema.safeParse(read(req));
      if (!parsed.success) {
        errors.push(...formatZodIssues(parsed.error.issues, section));
        continue;
      }

      if (parsed.data !== undefined) {
        nextValid[section] = parsed.data;
      }
    }

    if (errors.length > 0) {
      next(new BadRequestError("Error de validación", { errors }));
      return;
    }

    req.valid = nextValid;
    next();
  };
}
