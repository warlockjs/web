import { describe, expect, it } from "vitest";
import { resolveActionInput } from "./resolve-action-input";

describe("resolveActionInput()", () => {
  it("defaults to the `default` action and strips nothing else", () => {
    expect(resolveActionInput({ body: { email: "a@b.c" } })).toEqual({
      name: "default",
      validName: true,
      input: { email: "a@b.c" },
    });
  });

  it("reads the name from _action and removes it from the input", () => {
    const resolved = resolveActionInput({ body: { _action: "remove", id: "3" } });

    expect(resolved.name).toBe("remove");
    expect(resolved.validName).toBe(true);
    expect(resolved.input).toEqual({ id: "3" });
  });

  it("uses the first value of a repeated _action", () => {
    expect(resolveActionInput({ body: { _action: ["save", "remove"] } }).name).toBe("save");
  });

  it("flags names that do not match the action-name pattern", () => {
    expect(resolveActionInput({ body: { _action: "Bad-Name" } }).validName).toBe(false);
    expect(resolveActionInput({ body: { _action: { a: 1 } } }).validName).toBe(false);
  });

  it("tolerates a missing body", () => {
    expect(resolveActionInput({})).toEqual({ name: "default", validName: true, input: {} });
  });
});
