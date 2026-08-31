import { afterEach, describe, expect, it } from "vitest";
import { serializePageError } from "./error-page";

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

describe("serializePageError", () => {
  it("omits stack from production hydration props", () => {
    process.env.NODE_ENV = "production";
    const error = new TypeError("database connection failed");
    error.stack = "TypeError: database connection failed\n    at internal.ts:1:1";

    const serialized = serializePageError(error);

    expect(serialized).toEqual({ name: "TypeError", message: "database connection failed" });
    expect(serialized).not.toHaveProperty("stack");
  });

  it("preserves stack, name, and message in development", () => {
    process.env.NODE_ENV = "development";
    const error = new TypeError("database connection failed");
    error.stack = "TypeError: database connection failed\n    at page.tsx:4:2";

    expect(serializePageError(error)).toEqual({
      name: "TypeError",
      message: "database connection failed",
      stack: "TypeError: database connection failed\n    at page.tsx:4:2",
    });
  });
});
