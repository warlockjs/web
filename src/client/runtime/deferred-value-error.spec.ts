import { describe, expect, it } from "vitest";
import { DeferredValueError } from "./deferred-value-error";

describe("DeferredValueError", () => {
  it("carries the message and name", () => {
    const error = new DeferredValueError("boom");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DeferredValueError");
    expect(error.message).toBe("boom");
    expect(error.statusCode).toBeUndefined();
  });

  it("carries an optional statusCode", () => {
    const error = new DeferredValueError("not found", 404);

    expect(error.statusCode).toBe(404);
  });
});
