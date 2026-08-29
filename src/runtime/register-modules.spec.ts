import { describe, expect, it, vi } from "vitest";
import { registerModules, type RegisterableModuleNamespace } from "./register-modules";

function moduleWith(register?: () => unknown): RegisterableModuleNamespace {
  return { register };
}

describe("registerModules", () => {
  it("runs registration hooks synchronously in supplied order", () => {
    const calls: string[] = [];

    registerModules([
      moduleWith(() => calls.push("app")),
      moduleWith(() => calls.push("layout")),
      moduleWith(() => calls.push("page")),
    ]);

    expect(calls).toEqual(["app", "layout", "page"]);
  });

  it("deduplicates namespace identities across calls, including shared layouts", () => {
    const calls: string[] = [];
    const app = moduleWith(() => calls.push("app"));
    const sharedLayout = moduleWith(() => calls.push("layout"));
    const firstPage = moduleWith(() => calls.push("first page"));
    const secondPage = moduleWith(() => calls.push("second page"));

    registerModules([app, sharedLayout, firstPage]);
    registerModules([app, sharedLayout, secondPage]);

    expect(calls).toEqual(["app", "layout", "first page", "second page"]);
  });

  it("registers a replacement namespace once while keeping the original deduped", () => {
    const calls: string[] = [];
    const original = moduleWith(() => calls.push("original"));
    const replacement = moduleWith(() => calls.push("replacement"));

    registerModules([original]);
    registerModules([original, replacement]);
    registerModules([original, replacement]);

    expect(calls).toEqual(["original", "replacement"]);
  });

  it("retries a hook that previously threw", () => {
    const register = vi
      .fn<() => void>()
      .mockImplementationOnce(() => {
        throw new Error("first attempt failed");
      });
    const module = moduleWith(register);

    expect(() => registerModules([module])).toThrow("first attempt failed");
    expect(() => registerModules([module])).not.toThrow();
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("ignores non-Promise return values", () => {
    const register = vi.fn(() => 42);
    const module = moduleWith(register);

    registerModules([module]);
    registerModules([module]);

    expect(register).toHaveBeenCalledTimes(1);
  });

  it("rejects Promise-returning hooks before registering their namespace", () => {
    const register = vi.fn(async () => undefined);
    const module = moduleWith(register);

    expect(() => registerModules([module])).toThrow(
      "Warlock register() hooks must be synchronous",
    );
    expect(() => registerModules([module])).toThrow(
      "Warlock register() hooks must be synchronous",
    );
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("rejects thenable-returning hooks", () => {
    const module = moduleWith(() => ({ then() {} }));

    expect(() => registerModules([module])).toThrow(
      "Warlock register() hooks must be synchronous",
    );
  });

  it("treats a missing register hook as a no-op", () => {
    expect(() => registerModules([{}])).not.toThrow();
  });
});
