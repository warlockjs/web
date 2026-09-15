import { describe, expect, it } from "vitest";
import { DeferredStreamClosedError } from "./deferred-stream-closed-error";

describe("DeferredStreamClosedError", () => {
  it("carries the key and a descriptive message", () => {
    const error = new DeferredStreamClosedError("reviews");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DeferredStreamClosedError");
    expect(error.key).toBe("reviews");
    expect(error.message).toContain("reviews");
    expect(error.message).toContain("stream closed");
  });
});
