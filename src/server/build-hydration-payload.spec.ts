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

describe("buildHydrationPayload — route translation snapshots", () => {
  it("serializes only the selected snapshot and marks scoped mode", () => {
    const payload = buildHydrationPayload(
      bundleOf({
        routeTranslations: {
          locale: "en",
          revision: "account-en",
          keywords: { account: { title: "Account" } },
        },
      }),
      "en",
    );

    expect(payload.translations).toEqual({ account: { title: "Account" } });
    expect(payload.translations).not.toHaveProperty("catalog");
    expect(payload.translationMode).toBe("scoped");
  });

  it("refuses mismatched locales instead of leaking the global registry into a scoped payload", () => {
    expect(() =>
      buildHydrationPayload(
        bundleOf({
          routeTranslations: {
            locale: "ar",
            revision: "account-ar",
            keywords: { account: { title: "Arabic account" } },
          },
        }),
        "en",
      ),
    ).toThrow(/snapshot locale.*does not match payload locale/);
  });
});

/**
 * RELEASE BLOCKER fix (5.17): `inlinedDeferredKeys` — the marker
 * `render-page.ts`'s data-request/crawler await-and-inline path sets once a
 * deferred key's value has already been awaited and put back into `pageData`
 * as a plain, resolved value (`PageDataBundle.inlinedDeferredKeys`'s own
 * doc). Unlike a genuinely streamed `deferredKeys` entry, the wire keeps the
 * VALUE (it is JSON-safe and IS the answer) — only the marker is added, so
 * the client still knows to wrap it in an already-fulfilled thenable before
 * `use()` reads it.
 */
describe("buildHydrationPayload — inlinedDeferredKeys (a serverCache route's JSON representation)", () => {
  it("marks an inlined key `deferred` on the wire WITHOUT deleting its resolved value", () => {
    const bundle = bundleOf({
      pageData: { title: "Post", related: { slug: "next-post" } },
      inlinedDeferredKeys: ["related"],
    });

    const payload = buildHydrationPayload(bundle, "en");

    expect(payload.deferred).toEqual(["related"]);
    expect(payload.pageData).toEqual({ title: "Post", related: { slug: "next-post" } });
  });

  it("combines a genuinely streamed key and an inlined key in declaration order", () => {
    const bundle = bundleOf({
      pageData: { comments: "STREAMED — deleted below", related: { slug: "next-post" } },
      deferredKeys: ["comments"],
      inlinedDeferredKeys: ["related"],
    });

    const payload = buildHydrationPayload(bundle, "en");

    expect(payload.deferred).toEqual(["comments", "related"]);
    // The streamed key is removed (a live Promise is not JSON-safe and
    // settles separately); the inlined key's plain value stays.
    expect(payload.pageData).toEqual({ related: { slug: "next-post" } });
  });

  it("omits `deferred` entirely when neither list is present — unchanged for an ordinary page", () => {
    const bundle = bundleOf({ pageData: { title: "Post" } });

    const payload = buildHydrationPayload(bundle, "en");

    expect(payload.deferred).toBeUndefined();
  });
});

describe("buildHydrationPayload — actionData and session", () => {
  it("omits both keys when not provided", () => {
    const payload = buildHydrationPayload(bundleOf(), "en");

    expect("actionData" in payload).toBe(false);
    expect("session" in payload).toBe(false);
  });

  it("omits both keys when explicitly undefined", () => {
    const payload = buildHydrationPayload(bundleOf(), "en", {
      actionData: undefined,
      session: undefined,
    });

    expect("actionData" in payload).toBe(false);
    expect("session" in payload).toBe(false);
  });

  it("emits both keys when provided, including a guest session", () => {
    const payload = buildHydrationPayload(bundleOf(), "en", {
      actionData: { data: { ok: true } },
      session: { user: null },
    });

    expect(payload.actionData).toEqual({ data: { ok: true } });
    expect(payload.session).toEqual({ user: null });
  });
});
