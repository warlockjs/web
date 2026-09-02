import { describe, expect, it } from "vitest";
import {
  canonicalizeRouteExport,
  InvalidPageCacheOptInError,
  resolvePageRouteCache,
} from "./route-identity";

describe("canonicalizeRouteExport", () => {
  it("canonicalizes the bare-string shorthand into { path }", () => {
    // install-page-routes.ts:87-88 — `typeof routeExport === "string"` returns
    // `{ path: routeExport, name: deriveRouteName(...) }`; the `path` half is
    // the string verbatim.
    expect(canonicalizeRouteExport("/contact-us")).toEqual({ path: "/contact-us" });
  });

  it("canonicalizes an object route with no name into { path }, no `name` key", () => {
    // install-page-routes.ts:91-94 — the object form's `path` passes through
    // and `name` is `routeExport.name ?? deriveRouteName(...)`; a fallback is
    // `resolvePageRouteName`'s concern, not canonicalizeRouteExport's.
    expect(canonicalizeRouteExport({ path: "/settings" })).toEqual({ path: "/settings" });
  });

  it("keeps an explicit object `name` verbatim, whatever it is", () => {
    // install-page-routes.ts:92-93 — `name: routeExport.name ?? ...` never
    // rewrites a name that is already there. Verified against the real fixture
    // v5/app/src/app/users/web/account/settings.page.tsx:43-46, whose declared
    // route is `{ path: "/settings", name: "users.account.settings" }` — a name
    // that deriveRouteName from "/settings" alone could never reproduce (it
    // would yield "users.settings", missing the "account" layout segment),
    // which is exactly why an explicit name must win untouched.
    expect(canonicalizeRouteExport({ path: "/settings", name: "users.account.settings" })).toEqual({
      path: "/settings",
      name: "users.account.settings",
    });
  });
});

describe("resolvePageRouteCache", () => {
  it("returns undefined when the route export is undefined", () => {
    expect(resolvePageRouteCache(undefined, "src/web/home.page.tsx")).toBeUndefined();
  });

  it("returns undefined for the bare-string route shorthand — a string cannot carry a cache opt-in", () => {
    expect(resolvePageRouteCache("/contact-us", "src/web/contact-us.page.tsx")).toBeUndefined();
  });

  it("returns undefined when the object route declares no cache key at all", () => {
    expect(
      resolvePageRouteCache({ path: "/settings" }, "src/web/settings.page.tsx"),
    ).toBeUndefined();
  });

  it("returns the opt-in verbatim when both public: true and a numeric maxAge are declared", () => {
    expect(
      resolvePageRouteCache(
        { path: "/products", cache: { public: true, maxAge: 60 } },
        "src/web/products.page.tsx",
      ),
    ).toEqual({ public: true, maxAge: 60 });
  });

  it("throws InvalidPageCacheOptInError, naming the page file, when public: true is declared with no maxAge — this is a BOOT-TIME error, never a silent default", () => {
    expect(() =>
      resolvePageRouteCache(
        // A malformed opt-in reaches this function as `unknown`-shaped data at
        // runtime (the module's real export), even though `PageCacheOptIn`
        // requires `maxAge` at the type level — hence the cast.
        { path: "/products", cache: { public: true } as never },
        "src/web/products.page.tsx",
      ),
    ).toThrowError(InvalidPageCacheOptInError);

    try {
      resolvePageRouteCache(
        { path: "/products", cache: { public: true } as never },
        "src/web/products.page.tsx",
      );
      throw new Error("expected resolvePageRouteCache to throw");
    } catch (error) {
      expect((error as Error).message).toContain("src/web/products.page.tsx");
      expect((error as Error).message).toContain("cache: { public: true, maxAge: <seconds> }");
    }
  });

  it("throws InvalidPageCacheOptInError when maxAge is present but not a number", () => {
    expect(() =>
      resolvePageRouteCache(
        { path: "/products", cache: { public: true, maxAge: "60" } as never },
        "src/web/products.page.tsx",
      ),
    ).toThrowError(InvalidPageCacheOptInError);
  });
});
