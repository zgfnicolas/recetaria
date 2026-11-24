import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { BadRequestError, PreconditionRequiredError } from "../shared/errors/app-error.js";
import {
  IF_MATCH_MALFORMED_MESSAGE,
  IF_MATCH_REQUIRED_MESSAGE,
  IF_MATCH_SINGLE_TAG_MESSAGE,
  requireIfMatchMiddleware,
  type RequireIfMatchOptions,
} from "./if-match.middleware.js";

function createHarness(options?: RequireIfMatchOptions): {
  readonly app: express.Express;
  readonly errors: unknown[];
} {
  const errors: unknown[] = [];
  const app = express();
  app.put("/r", requireIfMatchMiddleware(options), (req, res) => {
    res.json({ preconditions: req.preconditions });
  });
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    errors.push(err);
    res.status(599).end();
  });
  return { app, errors };
}

describe("requireIfMatchMiddleware (#46)", () => {
  it.each([
    ["sin header", undefined],
    ["vacío", ""],
    ["comodín *", "*"],
  ])("responde 428 %s, sin llegar al handler", async (_label, header) => {
    // Arrange
    const { app, errors } = createHarness();

    // Act
    const req = request(app).put("/r");
    await (header === undefined ? req : req.set("If-Match", header));

    // Assert
    expect(errors[0]).toBeInstanceOf(PreconditionRequiredError);
    expect(errors[0]).toMatchObject({ statusCode: 428, message: IF_MATCH_REQUIRED_MESSAGE });
  });

  it("responde 400 con el campo If-Match si la sintaxis es inválida", async () => {
    // Arrange
    const { app, errors } = createHarness();

    // Act
    await request(app).put("/r").set("If-Match", "3");

    // Assert
    expect(errors[0]).toBeInstanceOf(BadRequestError);
    expect(errors[0]).toMatchObject({
      statusCode: 400,
      errors: [{ field: "If-Match", message: IF_MATCH_MALFORMED_MESSAGE }],
    });
  });

  it("deja las etiquetas parseadas en req.preconditions.ifMatch", async () => {
    // Arrange
    const { app, errors } = createHarness();

    // Act
    const res = await request(app).put("/r").set("If-Match", '"2", W/"3"');

    // Assert
    expect(errors).toEqual([]);
    expect(res.body).toEqual({
      preconditions: {
        ifMatch: [
          { opaque: "2", weak: false },
          { opaque: "3", weak: true },
        ],
      },
    });
  });

  it("con singleTag rechaza una lista de ETags con 400 (evita enumerar versiones como un *)", async () => {
    // Arrange
    const { app, errors } = createHarness({ singleTag: true });

    // Act
    await request(app).put("/r").set("If-Match", '"1", "2", "3"');

    // Assert
    expect(errors[0]).toBeInstanceOf(BadRequestError);
    expect(errors[0]).toMatchObject({
      errors: [{ field: "If-Match", message: IF_MATCH_SINGLE_TAG_MESSAGE }],
    });
  });

  it("con singleTag acepta exactamente un ETag", async () => {
    // Arrange
    const { app, errors } = createHarness({ singleTag: true });

    // Act
    const res = await request(app).put("/r").set("If-Match", '"4"');

    // Assert
    expect(errors).toEqual([]);
    expect(res.body).toEqual({ preconditions: { ifMatch: [{ opaque: "4", weak: false }] } });
  });
});
