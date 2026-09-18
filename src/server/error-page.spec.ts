import { afterEach, describe, expect, it } from "vitest";
import { setEnvironment } from "@warlock.js/core";
import { serializePageError } from "./error-page";
import { PublicPageError } from "./public-page-error";

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

describe("serializePageError", () => {
  it("never exposes an unexpected error's own message in production", () => {
    setEnvironment("production");
    const error = new Error("db password=hunter2");

    const serialized = serializePageError(error);

    expect(serialized.message).toBe("An unexpected error occurred.");
    expect(serialized.message).not.toContain("hunter2");
    expect(serialized).not.toHaveProperty("stack");
    expect(typeof serialized.errorCode).toBe("string");
    expect(serialized.errorCode!.length).toBeGreaterThan(0);
  });

  it("reuses the given request id as the production errorCode, joinable with the server report line", () => {
    setEnvironment("production");
    const error = new Error("db password=hunter2");

    const serialized = serializePageError(error, "req-abc123");

    expect(serialized.errorCode).toBe("req-abc123");
    expect(serialized.message).not.toContain("hunter2");
  });

  it("exposes a PublicPageError's own message in production, still without a stack", () => {
    setEnvironment("production");
    const error = new PublicPageError("This slug is already taken.");
    error.stack = "PublicPageError: This slug is already taken.\n    at internal.ts:1:1";

    const serialized = serializePageError(error);

    expect(serialized).toEqual({ name: "PublicPageError", message: "This slug is already taken." });
    expect(serialized).not.toHaveProperty("stack");
    expect(serialized).not.toHaveProperty("errorCode");
  });

  it("preserves stack, name, and message in development", () => {
    setEnvironment("development");
    const error = new TypeError("database connection failed");
    error.stack = "TypeError: database connection failed\n    at page.tsx:4:2";

    expect(serializePageError(error)).toEqual({
      name: "TypeError",
      message: "database connection failed",
      stack: "TypeError: database connection failed\n    at page.tsx:4:2",
    });
  });

  it("does not treat a status code or a matching error name alone as public", () => {
    setEnvironment("production");
    const disguised = new Error("db password=hunter2");
    disguised.name = "PublicPageError";
    (disguised as Error & { statusCode?: number }).statusCode = 400;

    expect(serializePageError(disguised).message).toBe("An unexpected error occurred.");
  });
});
