import { describe, expect, it } from "vitest";
import { canonicalizeRouteExport } from "./route-identity";

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
    expect(canonicalizeRouteExport({ path: "/settings", name: "users.account.settings" })).toEqual(
      { path: "/settings", name: "users.account.settings" },
    );
  });
});
