import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  loadClientRouteComposition,
  validateClientRouteManifest,
} from "./index";
import type { ClientRouteComposition, ClientRouteLoad } from "./types";

const validComposition = () => ({
  Page: { default: () => null },
  layouts: [{ default: () => null }],
  App: { default: () => null },
});

const validEntry = (overrides: Record<string, unknown> = {}) => ({
  type: "page",
  name: "users.show",
  path: "/users/:id",
  load: async () => validComposition(),
  ...overrides,
});

describe("ClientRouteLoad", () => {
  it("exposes the validated composition contract", () => {
    expectTypeOf<ClientRouteLoad>().toEqualTypeOf<
      () => ClientRouteComposition | Promise<ClientRouteComposition>
    >();
  });
});

function withoutKey(key: "type" | "name" | "path" | "load") {
  const entry: Record<string, unknown> = validEntry();
  delete entry[key];
  return entry;
}

describe("validateClientRouteManifest", () => {
  it("accepts an empty manifest", () => {
    expect(validateClientRouteManifest([])).toEqual([]);
  });

  it("preserves entry order, identity, and route grammar values verbatim", () => {
    const first = validEntry({ path: " /users/{id}?draft=:draft " });
    const second = validEntry({ name: "search", path: "/search/*rest" });

    const result = validateClientRouteManifest([first, second]);

    expect(result).toEqual([first, second]);
    expect(result[0]).toBe(first);
    expect(result[1]).toBe(second);
    expect(result[0].path).toBe(" /users/{id}?draft=:draft ");
  });

  it("rejects an unknown key and identifies it", () => {
    expect(() =>
      validateClientRouteManifest([validEntry({ providerId: "virtual:pages" })]),
    ).toThrow(/providerId/);
  });

  it("rejects symbol keys", () => {
    const entry = validEntry();
    Object.defineProperty(entry, Symbol("hidden"), { value: true });

    expect(() => validateClientRouteManifest([entry])).toThrow(/hidden/);
  });

  it.each(["type", "name", "path", "load"] as const)(
    "rejects a missing %s key and identifies it",
    (key) => {
      expect(() => validateClientRouteManifest([withoutKey(key)])).toThrow(
        new RegExp(key),
      );
    },
  );

  it("rejects an unknown type and identifies its value", () => {
    expect(() =>
      validateClientRouteManifest([validEntry({ type: "endpoint" })]),
    ).toThrow(/endpoint/);
  });

  it.each([
    ["the manifest is not an array", {}],
    ["an entry is an array", [[]]],
    ["an entry is null", [null]],
    ["name is empty", [validEntry({ name: "   " })]],
    ["name is not a string", [validEntry({ name: 42 })]],
    ["path is empty", [validEntry({ path: "" })]],
    ["path is not a string", [validEntry({ path: null })]],
    ["load is not callable", [validEntry({ load: true })]],
  ])("rejects %s", (_caseName, input) => {
    expect(() => validateClientRouteManifest(input)).toThrow();
  });

  it("rejects accessor-backed fields without invoking them", () => {
    const getter = vi.fn(() => "page");
    const entry = validEntry();
    Object.defineProperty(entry, "type", {
      enumerable: true,
      get: getter,
    });

    expect(() => validateClientRouteManifest([entry])).toThrow(/data property/);
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects duplicate names and identifies the colliding value", () => {
    expect(() =>
      validateClientRouteManifest([
        validEntry(),
        validEntry({ path: "/members/:id" }),
      ]),
    ).toThrow(/users\.show/);
  });

  it("rejects duplicate paths and identifies the colliding value", () => {
    expect(() =>
      validateClientRouteManifest([
        validEntry(),
        validEntry({ name: "members.show" }),
      ]),
    ).toThrow(/\/users\/:id/);
  });
});

describe("loadClientRouteComposition", () => {
  it("calls the provider on every invocation and preserves the full composition", async () => {
    const composition = validComposition();
    const load = vi.fn(async () => composition);
    const [entry] = validateClientRouteManifest([validEntry({ load })]);

    const first = await loadClientRouteComposition(entry);
    const second = await loadClientRouteComposition(entry);

    expect(load).toHaveBeenCalledTimes(2);
    expect(first).toBe(composition);
    expect(second).toBe(composition);
    expect(first.App).toBe(composition.App);
  });

  it.each([
    ["a blank result", undefined],
    ["an array result", []],
    ["a missing Page", { layouts: [] }],
    ["a missing layouts", { Page: {} }],
    ["a blank Page", { Page: null, layouts: [] }],
    ["non-array layouts", { Page: {}, layouts: {} }],
    ["a blank layout", { Page: {}, layouts: [null] }],
    ["an explicitly blank App", { Page: {}, layouts: [], App: undefined }],
    ["an extra composition key", { Page: {}, layouts: [], providerId: "dev" }],
  ])("rejects %s rather than returning fallback data", async (_caseName, value) => {
    const [entry] = validateClientRouteManifest([
      validEntry({ load: async () => value }),
    ]);

    await expect(loadClientRouteComposition(entry)).rejects.toThrow();
  });

  it("allows App to be absent", async () => {
    const composition = { Page: {}, layouts: [] };
    const [entry] = validateClientRouteManifest([
      validEntry({ load: async () => composition }),
    ]);

    await expect(loadClientRouteComposition(entry)).resolves.toBe(composition);
  });

  it("propagates a provider failure", async () => {
    const failure = new Error("provider failed");
    const [entry] = validateClientRouteManifest([
      validEntry({
        load: async () => {
          throw failure;
        },
      }),
    ]);

    await expect(loadClientRouteComposition(entry)).rejects.toBe(failure);
  });
});
