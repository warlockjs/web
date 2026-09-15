import { describe, expect, it } from "vitest";
import { buildHydrationPayload } from "./build-hydration-payload";
import { PageDataSerializationError } from "./page-data-serialization-error";
import type { PageDataBundle } from "./execute-page-request";

class UnserializableService {
  public constructor(public readonly name: string) {}
}

function bundleOf(overrides: Partial<PageDataBundle> = {}): PageDataBundle {
  return {
    route: { name: "products.details", path: "/products/:id", params: { id: "7" }, query: {} },
    appData: {},
    layoutData: {},
    pageData: {},
    shared: {} as PageDataBundle["shared"],
    ...overrides,
  };
}

/**
 * The dev/prod diagnostic (standing serialization ruling): a loader value
 * devalue refuses becomes a `PageDataSerializationError` naming the loader
 * LEVEL, the KEY PATH devalue's own `DevalueError` reports, and the page
 * ROUTE — never a bare devalue throw the caller has to decode by hand. This
 * is UNCONDITIONAL: the same throw happens in dev and in prod, because a
 * browser cannot hydrate a value the server could not put on the wire in
 * either environment.
 */
describe("buildHydrationPayload — unserializable loader values", () => {
  it("names the PAGE level, the key path, and the route for an unserializable pageData value", () => {
    const bundle = bundleOf({
      pageData: { items: [{ service: new UnserializableService("billing") }] },
    });

    let thrown: unknown;

    try {
      buildHydrationPayload(bundle, "en");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PageDataSerializationError);
    const error = thrown as PageDataSerializationError;

    expect(error.level).toBe("page");
    expect(error.route).toBe("products.details");
    expect(error.path).toBe(".items[0].service");
    expect(error.message).toContain("page");
    expect(error.message).toContain("products.details");
    expect(error.message).toContain(".items[0].service");
    expect(error.message).toContain("resource");
    expect(error.message).toContain("toJSON()");
    expect(error.cause).toBeDefined();
  });

  it("names the APP level for an unserializable appData value", () => {
    const bundle = bundleOf({ appData: { config: new UnserializableService("app-config") } });

    expect(() => buildHydrationPayload(bundle, "en")).toThrow(PageDataSerializationError);

    try {
      buildHydrationPayload(bundle, "en");
    } catch (error) {
      expect((error as PageDataSerializationError).level).toBe("app");
    }
  });

  it("names the LAYOUT level for an unserializable layoutData value", () => {
    const bundle = bundleOf({ layoutData: { nav: new UnserializableService("nav") } });

    try {
      buildHydrationPayload(bundle, "en");
    } catch (error) {
      expect((error as PageDataSerializationError).level).toBe("layout");
    }
  });

  it("throws for a function value the same way it throws for a class instance", () => {
    const bundle = bundleOf({ pageData: { onClick: () => undefined } });

    expect(() => buildHydrationPayload(bundle, "en")).toThrow(PageDataSerializationError);
  });

  it("throws for a symbol value", () => {
    const bundle = bundleOf({ pageData: { token: Symbol("token") } });

    expect(() => buildHydrationPayload(bundle, "en")).toThrow(PageDataSerializationError);
  });

  it("does not throw for an ordinary serializable payload", () => {
    const bundle = bundleOf({
      appData: { a: 1 },
      layoutData: { l: new Date(0) },
      pageData: { p: new Map([["x", 1]]) },
    });

    expect(() => buildHydrationPayload(bundle, "en")).not.toThrow();
  });
});
