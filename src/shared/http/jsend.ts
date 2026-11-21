import type { Response } from "express";
import {
  freezeErrorDetails,
  type ErrorDetail,
  type HttpErrorStatusCode,
} from "../errors/app-error.js";

/** Códigos HTTP de respuesta exitosa contemplados en el contrato JSend extendido. */
export type HttpSuccessStatusCode = 200 | 201;

/** Sobre JSend extendido para respuestas exitosas (`ADR-0004`). */
export type JSendSuccessResponse<TData> = Readonly<{
  success: true;
  statusCode: HttpSuccessStatusCode;
  message: string;
  data: TData;
}>;

/** Sobre JSend extendido para respuestas de error (`ADR-0004`). */
export type JSendErrorResponse = Readonly<{
  success: false;
  statusCode: HttpErrorStatusCode;
  message: string;
  errors: readonly ErrorDetail[];
}>;

/** Unión discriminada del contrato completo JSend extendido. */
export type JSendResponse<TData> = JSendSuccessResponse<TData> | JSendErrorResponse;

export type BuildSuccessOptions<TData> = Readonly<{
  statusCode?: HttpSuccessStatusCode | undefined;
  message: string;
  data: TData;
}>;

export type BuildErrorOptions = Readonly<{
  statusCode: HttpErrorStatusCode;
  message: string;
  errors?: readonly ErrorDetail[] | undefined;
}>;

const EMPTY_ERRORS: readonly ErrorDetail[] = Object.freeze([]);

/**
 * Construye un sobre JSend extendido de éxito inmutable (default `200 OK`).
 */
export function buildSuccessResponse<TData>(
  options: BuildSuccessOptions<TData>,
): JSendSuccessResponse<TData> {
  return Object.freeze({
    success: true as const,
    statusCode: options.statusCode ?? 200,
    message: options.message,
    data: options.data,
  });
}

/**
 * Construye un sobre JSend extendido de error inmutable, garantizando siempre el arreglo `errors`.
 */
export function buildErrorResponse(options: BuildErrorOptions): JSendErrorResponse {
  const errors =
    options.errors === undefined || options.errors.length === 0
      ? EMPTY_ERRORS
      : freezeErrorDetails(options.errors);

  return Object.freeze({
    success: false as const,
    statusCode: options.statusCode,
    message: options.message,
    errors,
  });
}

/**
 * Emite una respuesta HTTP JSON exitosa siguiendo el contrato JSend extendido.
 */
export function sendSuccess<TData>(
  res: Response,
  options: BuildSuccessOptions<TData>,
): Response {
  const body = buildSuccessResponse(options);
  return res.status(body.statusCode).json(body);
}

/**
 * Emite una respuesta HTTP JSON de error siguiendo el contrato JSend extendido.
 */
export function sendError(res: Response, options: BuildErrorOptions): Response {
  const body = buildErrorResponse(options);
  return res.status(body.statusCode).json(body);
}
