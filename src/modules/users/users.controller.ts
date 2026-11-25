import type { NextFunction, Request, Response } from "express";
import type { ValidatedRequest } from "../../middlewares/validate.middleware.js";
import { BadRequestError, UnauthorizedError } from "../../shared/errors/app-error.js";
import { sendSuccess } from "../../shared/http/jsend.js";
import type { Actor } from "../auth/index.js";
import type { ChangeRoleDTO, ChangeStatusDTO, UserIdParamsDTO } from "./users.schema.js";
import type { IUserAdminService } from "./users.service.js";

function readActor(req: Request): Actor {
  if (req.user === undefined) {
    throw new UnauthorizedError("Autenticación requerida");
  }
  return req.user;
}

function readValidated<TBody>(req: Request): Readonly<{ params: UserIdParamsDTO; body: TBody }> {
  const valid = (req as Partial<ValidatedRequest<TBody, unknown, UserIdParamsDTO>>).valid;
  if (valid?.params === undefined || valid.body === undefined) {
    throw new BadRequestError("Error de validación");
  }
  return { params: valid.params, body: valid.body };
}

/** Controlador HTTP de administración de Usuarios (#53): `req`/`res`, `try/catch` y JSend. */
export class UserAdminController {
  readonly #service: IUserAdminService;

  constructor(service: IUserAdminService) {
    this.#service = service;
  }

  readonly changeRole = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = readActor(req);
      const { params, body } = readValidated<ChangeRoleDTO>(req);
      const user = await this.#service.changeRole(actor, params.id, body.role);
      sendSuccess(res, {
        statusCode: 200,
        message: "Rol actualizado exitosamente",
        data: user,
      });
    } catch (err: unknown) {
      next(err);
    }
  };

  readonly changeStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const actor = readActor(req);
      const { params, body } = readValidated<ChangeStatusDTO>(req);
      const user = await this.#service.changeStatus(actor, params.id, body.isActive);
      sendSuccess(res, {
        statusCode: 200,
        message: body.isActive ? "Cuenta activada exitosamente" : "Cuenta desactivada exitosamente",
        data: user,
      });
    } catch (err: unknown) {
      next(err);
    }
  };
}
