import type { NextFunction, Request, Response } from "express";
import type { ValidatedRequest } from "../../middlewares/validate.middleware.js";
import { BadRequestError } from "../../shared/errors/app-error.js";
import { sendSuccess } from "../../shared/http/jsend.js";
import type { LoginDTO, RegisterDTO } from "./auth.schema.js";
import type { IAuthService } from "./auth.service.js";

function readValidatedBody<TBody>(req: Request): TBody {
  const validatedReq = req as Partial<ValidatedRequest<TBody>>;
  const body = validatedReq.valid?.body;
  if (body === undefined) {
    throw new BadRequestError("Error de validación");
  }
  return body;
}

/**
 * Controlador HTTP del módulo `Auth`.
 * Extrae `req.valid.body`, delega en `IAuthService` y emite respuestas JSend.
 */
export class AuthController {
  readonly #authService: IAuthService;

  constructor(authService: IAuthService) {
    this.#authService = authService;
  }

  readonly register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = readValidatedBody<RegisterDTO>(req);
      const user = await this.#authService.register(body);
      sendSuccess(res, {
        statusCode: 201,
        message: "Usuario registrado exitosamente",
        data: user,
      });
    } catch (err: unknown) {
      next(err);
    }
  };

  readonly login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = readValidatedBody<LoginDTO>(req);
      const session = await this.#authService.login(body);
      res.setHeader("Cache-Control", "no-store");
      sendSuccess(res, {
        statusCode: 200,
        message: "Inicio de sesión exitoso",
        data: session,
      });
    } catch (err: unknown) {
      next(err);
    }
  };
}
