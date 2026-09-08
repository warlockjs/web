/**
 * Proves dev and production AGREE on a page's route name. Both installers now
 * call the SAME `resolvePageRouteIdentity` (`./route-identity.ts`) rather than
 * each deriving its own, so agreement is structural — this spec exercises
 * production's own `resolveRoute` (`../server/install-page-routes-from-manifest.ts`)
 * alongside the shared function directly, calling neither's internals and
 * reimplementing neither.
 *
 * Regression coverage for the defect this module's addition fixed: before
 * `resolvePageRouteName` existed, an explicit `route.path` with no `name`
 * derived the route name from the DECLARED PATH in production but from the
 * FILE PATH in dev, so renaming a page's URL silently broke every `<Link>`
 * built against the old, file-derived name.
 */
import { describe, expect, it } from "vitest";
import { resolveRoute } from "../server/install-page-routes-from-manifest";
import type { PageRouteExport } from "../server/install-page-routes";
import { resolvePageRouteIdentity } from "./route-identity";

/** Dev identifies a page by an absolute file path plus the `appSrcRoot` it sits under. */
const APP_SRC_ROOT = "/app/src";

function devName(route: PageRouteExport | undefined, webRelativePageFile: string): string {
  return resolvePageRouteIdentity(
    route,
    webRelativePageFile,
    `${APP_SRC_ROOT}/web/${webRelativePageFile}`,
  ).name;
}

/** Production identifies a page by its manifest `sourceFile`, `"<srcDir>/web/..."`. */
function prodName(route: PageRouteExport | undefined, webRelativePageFile: string): string {
  return resolveRoute(route, `src/web/${webRelativePageFile}`).name;
}

function assertParity(
  route: PageRouteExport | undefined,
  webRelativePageFile: string,
  expected: string,
): void {
  const dev = devName(route, webRelativePageFile);
  const prod = prodName(route, webRelativePageFile);

  expect(dev).toBe(prod);
  expect(dev).toBe(expected);
}

describe("route name parity — dev and production agree", () => {
  it("CONTROL: an explicit route name wins on both sides, untouched", () => {
    assertParity(
      { path: "/posts", name: "explicit.name" },
      "blog/archive.page.tsx",
      "explicit.name",
    );
  });

  it("CONTROL: no `route` export at all falls back to the filesystem name on both sides", () => {
    assertParity(undefined, "blog/archive.page.tsx", "blog.archive");
  });

  it("agrees on the FILE-PATH name for an object route with a differing declared path", () => {
    assertParity({ path: "/posts" }, "blog/archive.page.tsx", "blog.archive");
  });

  it("agrees on the FILE-PATH name for the bare-string route form", () => {
    assertParity("/posts", "blog/archive.page.tsx", "blog.archive");
  });

  it("agrees on the FILE-PATH name for an index page under a renamed directory route", () => {
    assertParity({ path: "/catalogue" }, "products/index.page.tsx", "products");
  });

  it("agrees on the FILE-PATH name when the declared path happens to match the file path", () => {
    assertParity({ path: "/about" }, "about.page.tsx", "about");
  });
});
