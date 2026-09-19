import { afterEach, describe, expect, it } from "vitest";
import { setEnvironment } from "@warlock.js/core";
import { serializePageError } from "./error-page";
import { hydrationErrorPageProps } from "./error-page";
import { PageValidationFailedError } from "./page-validation-failed-error";

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

describe("PageValidationFailedError disclosure (card 6781c6f3)", () => {
  it("keeps errors[] (input/type/error only) and a non-generic message in production", () => {
    setEnvironment("production");
    const error = new PageValidationFailedError([
      { input: "page", type: "numeric", error: "The page field must be a number." },
    ]);

    const serialized = serializePageError(error);

    expect(serialized.message).toBe("Page validation failed.");
    expect(serialized.message).not.toBe("An unexpected error occurred.");
    expect(serialized.errors).toEqual([
      { input: "page", type: "numeric", error: "The page field must be a number." },
    ]);
    expect(serialized).not.toHaveProperty("stack");
  });

  it("never lets a submitted value on the Seal error object reach the output", () => {
    setEnvironment("production");
    const error = new PageValidationFailedError([
      {
        input: "page",
        type: "numeric",
        error: "The page field must be a number.",
        value: "abc",
        secret: "should-never-appear",
      },
    ]);

    const serialized = serializePageError(error);

    expect(serialized.errors).toEqual([
      { input: "page", type: "numeric", error: "The page field must be a number." },
    ]);
    const json = JSON.stringify(serialized);
    expect(json).not.toContain("abc");
    expect(json).not.toContain("should-never-appear");
  });

  it("keeps a generic Error sanitized alongside validation disclosure", () => {
    setEnvironment("production");
    const error = new Error("db password=hunter2");

    const serialized = serializePageError(error);

    expect(serialized.message).toBe("An unexpected error occurred.");
    expect(serialized).not.toHaveProperty("errors");
    expect(serialized).not.toHaveProperty("stack");
  });

  it("agrees between SSR props and the hydration payload for a validation error", () => {
    setEnvironment("production");
    const error = new PageValidationFailedError([
      { input: "page", type: "numeric", error: "The page field must be a number." },
    ]);

    const hydration = hydrationErrorPageProps({ error, status: 400 }, error, "req-1");
    const ssrEquivalent = serializePageError(error, "req-1");

    expect(ssrEquivalent).toEqual(hydration.error);
    expect(hydration.error.errors).toEqual([
      { input: "page", type: "numeric", error: "The page field must be a number." },
    ]);
  });

  it("exposes errors in development too, alongside the stack", () => {
    setEnvironment("development");
    const error = new PageValidationFailedError([
      { input: "page", type: "numeric", error: "The page field must be a number." },
    ]);
    error.stack = "PageValidationFailedError: Page validation failed.\n    at internal.ts:1:1";

    const serialized = serializePageError(error);

    expect(serialized.message).toBe("Page validation failed.");
    expect(serialized.errors).toEqual([
      { input: "page", type: "numeric", error: "The page field must be a number." },
    ]);
    expect(serialized.stack).toBe(error.stack);
  });
});
