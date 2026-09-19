import { describe, expect, it } from "vitest";
import {
  BadRequestError,
  ForbiddenError,
  HttpError,
  ResourceNotFoundError,
  ServerError,
} from "@warlock.js/core";
import { resolveThrownHttpStatus } from "./resolve-thrown-http-status";

describe("resolveThrownHttpStatus", () => {
  it("reads thrown.statusCode first, when numeric and within 400-599", () => {
    const thrown = new Error("boom") as Error & { statusCode: number };
    thrown.statusCode = 400;

    expect(resolveThrownHttpStatus(thrown)).toBe(400);
  });

  it("ignores a statusCode outside the HTTP error range", () => {
    const thrown = new Error("boom") as Error & { statusCode: number };
    thrown.statusCode = 200;

    expect(resolveThrownHttpStatus(thrown)).toBeUndefined();
  });

  it("resolves every core HttpError subclass by its own `status`, duck-typed rather than instanceof", () => {
    expect(resolveThrownHttpStatus(new ResourceNotFoundError("missing"))).toBe(404);
    expect(resolveThrownHttpStatus(new ForbiddenError("nope"))).toBe(403);
    expect(resolveThrownHttpStatus(new BadRequestError("bad"))).toBe(400);
    expect(resolveThrownHttpStatus(new ServerError("boom"))).toBe(500);
    expect(resolveThrownHttpStatus(new HttpError(409, "conflict"))).toBe(409);
  });

  it("prefers statusCode over status when a value somehow carries both", () => {
    const thrown = new ForbiddenError("nope") as ForbiddenError & { statusCode: number };
    thrown.statusCode = 429;

    expect(resolveThrownHttpStatus(thrown)).toBe(429);
  });

  it("ignores a non-Error value even when it carries a status field — the statusCode short path stays numeric-only", () => {
    expect(resolveThrownHttpStatus({ status: 404, name: "ResourceNotFoundError" })).toBeUndefined();
  });

  it('ignores an Error whose name does not end in "Error" — the duck-typing guard', () => {
    const thrown = new Error("boom") as Error & { status: number };
    thrown.name = "Boom";
    thrown.status = 404;

    expect(resolveThrownHttpStatus(thrown)).toBeUndefined();
  });

  it("ignores a third-party error's upstream status (AxiosError-shaped)", () => {
    class AxiosError extends Error {
      public status = 404;
    }
    const thrown = new AxiosError("Request failed with status code 404");
    thrown.name = "AxiosError";

    expect(resolveThrownHttpStatus(thrown)).toBeUndefined();
  });

  it("resolves an HttpError from a second copy of core (same class name, different class)", () => {
    // A distinct class that is NAMED HttpError, as a second copy of core would be.
    class OtherCoreHttpError extends Error {
      public constructor(
        public status: number,
        message: string,
      ) {
        super(message);
      }
    }
    Object.defineProperty(OtherCoreHttpError, "name", { value: "HttpError" });
    class OtherNotFound extends OtherCoreHttpError {
      public constructor(message: string) {
        super(404, message);
      }
    }

    expect(resolveThrownHttpStatus(new OtherNotFound("gone"))).toBe(404);
  });

  it("ignores an Error's own `status` when it falls outside the HTTP error range", () => {
    const thrown = new Error("boom") as Error & { status: number };
    thrown.name = "RedirectError";
    thrown.status = 302;

    expect(resolveThrownHttpStatus(thrown)).toBeUndefined();
  });

  it("returns undefined for a plain throw carrying no status at all", () => {
    expect(resolveThrownHttpStatus(new Error("boom"))).toBeUndefined();
    expect(resolveThrownHttpStatus("a string throw")).toBeUndefined();
    expect(resolveThrownHttpStatus(undefined)).toBeUndefined();
  });
});
