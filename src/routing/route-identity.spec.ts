import { describe, expect, it } from "vitest";
import {
  canonicalizeRouteExport,
  deriveFallbackRouteName,
  NonPosixSourceFilePathError,
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
    // this module's separate concern (deriveFallbackRouteName), not
    // canonicalizeRouteExport's.
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
    expect(canonicalizeRouteExport({ path: "/settings", name: "users.account.settings" })).toEqual(
      { path: "/settings", name: "users.account.settings" },
    );
  });
});

describe("deriveFallbackRouteName — module pages (src/app/<module>/web/**)", () => {
  it("derives `<module>.<dotted path>` for a non-root module page", () => {
    // The dev installer's former hand-derivation (moduleNameFor +
    // deriveRouteName, since deleted in favour of this module):
    // moduleName = relative(appSrcRoot/app, pageFile).split(sep)[0] = "main";
    // suffix = trim("/contact-us".replace(/\//g, "."), ".") = "contact-us";
    // suffix is non-empty, so `${moduleName}.${suffix}` = "main.contact-us".
    // Verified against the real fixture
    // v5/app/src/app/main/web/contact-us.page.tsx:27 (`route = "/contact-us"`)
    // and its own header comment, line 5: "The route NAME is then derived
    // (`main.contact-us`)".
    expect(
      deriveFallbackRouteName({
        routePath: "/contact-us",
        sourceFile: "src/app/main/web/contact-us.page.tsx",
      }),
    ).toBe("main.contact-us");
  });

  it("derives a nested module page the same way — module prefix, dotted suffix", () => {
    // Same former installer rule as above, on a deeper file: moduleName = "users",
    // suffix = trim("/settings".replace(/\//g, "."), ".") = "settings", giving
    // "users.settings". (The real settings.page.tsx declares the richer
    // explicit name "users.account.settings" instead — see the
    // canonicalizeRouteExport "explicit name" case above for why: derivation
    // from `route.path` alone cannot see the "account" layout segment.)
    expect(
      deriveFallbackRouteName({
        routePath: "/settings",
        sourceFile: "src/app/users/web/account/settings.page.tsx",
      }),
    ).toBe("users.settings");
  });

  it("derives just the module name for a root page (route path \"/\")", () => {
    // From the same former installer rule: suffix = trim("/".replace(/\//g,
    // "."), ".") = trim(".", ".") = "" — empty, so the derivation returns
    // `moduleName` alone, not "<module>.index" and not "index". Also confirmed by
    // discover-pages.spec.ts:140-153, whose `discoverPages` mirrors this same
    // installer rule: `"src/app/shop/web/index.page.tsx": routed("/")` resolves
    // `routeName` to `"shop"`, not `"shop.index"`.
    expect(
      deriveFallbackRouteName({
        routePath: "/",
        sourceFile: "src/app/main/web/index.page.tsx",
      }),
    ).toBe("main");
  });
});

describe("deriveFallbackRouteName — global pages (src/web/**)", () => {
  it("derives the dotted path alone, no module prefix, for a non-root global page", () => {
    // Discovery's convention, which the dev installer inherited when it was
    // made to enumerate global (`src/web/**`) pages and delegate naming here:
    // `moduleName` is `undefined`
    // for the global root, so `parts` is just the path segments joined by ".".
    // Confirmed by discover-pages.spec.ts's "still orders two pages ..." case:
    // `"src/web/alpha.page.tsx": routed("/alpha")` resolves `routeName` to
    // `"alpha"`.
    expect(
      deriveFallbackRouteName({
        routePath: "/contact-us",
        sourceFile: "src/web/contact-us.page.tsx",
      }),
    ).toBe("contact-us");
  });

  it('derives "index" for the root page at the global web root (route path "/")', () => {
    // Same convention as above (discovery's former `routeNameFor`, since
    // deleted in favour of this module): no module, and
    // `"/".split("/").filter(...)` is `[]`, so `parts` is empty and the
    // function's own fallback fires — `parts.length === 0 ? "index" : ...`.
    expect(
      deriveFallbackRouteName({
        routePath: "/",
        sourceFile: "src/web/index.page.tsx",
      }),
    ).toBe("index");
  });
});

describe("deriveFallbackRouteName — canonical-input boundary", () => {
  it("rejects a sourceFile containing a backslash with a named error", () => {
    // Module boundary decision (not mirrored from either duplicate): canonical
    // means canonical. A caller that hands in an OS path with `\\` separators
    // (e.g. an un-normalized Windows absolute path) gets a loud, named failure
    // instead of a silent wrong answer or a hidden normalization.
    expect(() =>
      deriveFallbackRouteName({
        routePath: "/contact-us",
        sourceFile: "src\\app\\main\\web\\contact-us.page.tsx",
      }),
    ).toThrow(NonPosixSourceFilePathError);
  });
});
