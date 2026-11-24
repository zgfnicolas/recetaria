/** Detalle de error de validación asociado a un campo o parámetro. */
export type ErrorDetail = Readonly<{
  field: string;
  message: string;
}>;

/** Códigos de estado HTTP de error contemplados en Recetaria API. */
export type HttpErrorStatusCode =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 412
  | 413
  | 422
  | 428
  | 429
  | 500
  | 502
  | 503
  | 504;

export type AppErrorOptions = Readonly<{
  errors?: readonly ErrorDetail[] | undefined;
  isOperational?: boolean | undefined;
  cause?: unknown;
}>;

/**
 * Congela una copia defensiva de los detalles de error por campo para preservar inmutabilidad.
 */
export function freezeErrorDetails(errors: readonly ErrorDetail[]): readonly ErrorDetail[] {
  return Object.freeze(
    errors.map((detail) => Object.freeze({ field: detail.field, message: detail.message })),
  );
}

/**
 * Error operacional base de la aplicación, desacoplado de Express y traducido a JSend.
 * Compatible con `erasableSyntaxOnly` y `exactOptionalPropertyTypes`.
 */
export class AppError extends Error {
  readonly statusCode: HttpErrorStatusCode;
  readonly isOperational: boolean;
  declare readonly errors?: readonly ErrorDetail[];

  constructor(statusCode: HttpErrorStatusCode, message: string, options?: AppErrorOptions) {
    super(
      message,
      options !== undefined && "cause" in options ? { cause: options.cause } : undefined,
    );

    if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) {
      throw new RangeError(`Código HTTP de error inválido: ${String(statusCode)}`);
    }

    this.name = new.target.name;
    this.statusCode = statusCode;
    this.isOperational = options?.isOperational ?? true;

    // Omitir la propiedad por completo cuando no hay detalles para respetar exactOptionalPropertyTypes.
    if (options?.errors !== undefined) {
      this.errors = freezeErrorDetails(options.errors);
    }
  }
}

/** Error 400 Bad Request para fallos de validación o entrada sintácticamente inválida. */
export class BadRequestError extends AppError {
  constructor(message = "Solicitud inválida", options?: AppErrorOptions) {
    super(400, message, options);
  }
}

/** Error 401 Unauthorized para ausencia o invalidez de credenciales/token JWT. */
export class UnauthorizedError extends AppError {
  constructor(message = "No autorizado", options?: AppErrorOptions) {
    super(401, message, options);
  }
}

/** Error 403 Forbidden para fallos de autorización RBAC, ownership o auto-aprobación. */
export class ForbiddenError extends AppError {
  constructor(message = "Permisos insuficientes", options?: AppErrorOptions) {
    super(403, message, options);
  }
}

/** Error 404 Not Found para recursos o rutas inexistentes. */
export class NotFoundError extends AppError {
  constructor(message = "Recurso no encontrado", options?: AppErrorOptions) {
    super(404, message, options);
  }
}

/** Error 409 Conflict para colisiones de unicidad o transiciones de estado inválidas. */
export class ConflictError extends AppError {
  constructor(message = "Conflicto con el estado actual del recurso", options?: AppErrorOptions) {
    super(409, message, options);
  }
}

/**
 * Error 412 Precondition Failed: el `If-Match` enviado no coincide con la versión actual del
 * recurso (bloqueo optimista, RFC 9110 §13.1.1).
 */
export class PreconditionFailedError extends AppError {
  constructor(message = "La versión del recurso cambió", options?: AppErrorOptions) {
    super(412, message, options);
  }
}

/** Error 428 Precondition Required: la operación exige un `If-Match` condicional (RFC 6585 §3). */
export class PreconditionRequiredError extends AppError {
  constructor(message = "Se requiere una solicitud condicional", options?: AppErrorOptions) {
    super(428, message, options);
  }
}

/** Error 503 Service Unavailable cuando una dependencia crítica (p. ej. PostgreSQL) no responde. */
export class ServiceUnavailableError extends AppError {
  constructor(message = "Servicio no disponible", options?: AppErrorOptions) {
    super(503, message, options);
  }
}
