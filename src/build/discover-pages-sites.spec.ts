import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SitesConfig } from "../sites/site-config.types";
import {
  discoverPages,
  DuplicatePageRouteNameError,
  DuplicatePageRoutePathError,
  type DiscoveredPage,
} from "./discover-pages";

const temporaryDirectories: string[] = [];

function makeAppTree(files: Record<string, string>): string {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-sites-"));
  temporaryDirectories.push(appRoot);

  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(appRoot, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf-8");
  }

  return appRoot;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

const COMPONENT = "export default function C() { return null; }\n";
const named = (name: string, routePath: string) =>
  `export const config = { route: { path: "${routePath}", name: "${name}" } };\n${COMPONENT}`;

const SITES: SitesConfig = {
  landing: { pages: "(landing)", hosts: ["estates.app"] },
  platform: { pages: "(platform)", hosts: ["app.estates.app"] },
  tenant: { pages: "(tenant)", dynamic: true },
  tenantAdmin: { pages: "(tenant-admin)", dynamic: true },
};

/** Real-Estate layout: four sites, each with a root and an index page. */
function realEstate(extra: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = {};

  for (const site of Object.values(SITES)) {
    files[`src/web/${site.pages}/root.tsx`] = COMPONENT;
    files[`src/web/${site.pages}/index.page.tsx`] = COMPONENT;
  }

  return { ...files, ...extra };
}

const pagesOf = (pages: DiscoveredPage[]) =>
  pages.filter((page) => page.type === "page") as Extract<DiscoveredPage, { type: "page" }>[];

describe("discoverPages with sites", () => {
  it("maps the same path on different sites without a collision", () => {
    const appRoot = makeAppTree(realEstate());
    const pages = pagesOf(discoverPages({ appRoot, sites: SITES }));

    expect(pages.map((page) => [page.site, page.routePath])).toEqual([
      ["landing", "/"],
      ["platform", "/"],
      ["tenant", "/"],
      ["tenantAdmin", "/"],
    ]);
  });

  it("gives every page its own site's root and root.setup.ts", () => {
    const appRoot = makeAppTree(
      realEstate({ "src/web/(tenant)/root.setup.ts": "export const config = { strictMode: true };\n" }),
    );
    const pages = pagesOf(discoverPages({ appRoot, sites: SITES }));
    const tenant = pages.find((page) => page.site === "tenant");
    const landing = pages.find((page) => page.site === "landing");

    expect(tenant?.appFile).toBe(path.join(appRoot, "src/web/(tenant)/root.tsx"));
    expect(tenant?.appSetupFile).toBe(path.join(appRoot, "src/web/(tenant)/root.setup.ts"));
    expect(landing?.appFile).toBe(path.join(appRoot, "src/web/(landing)/root.tsx"));
    expect(landing?.appSetupFile).toBeUndefined();
  });

  it("prefixes generated names with the site and leaves explicit names alone", () => {
    const appRoot = makeAppTree(
      realEstate({
        "src/web/(landing)/pricing.page.tsx": COMPONENT,
        "src/web/(landing)/about.page.tsx": named("company.about", "/about"),
        "src/web/(landing)/welcome.page.tsx": `export const config = { route: "/welcome" };\n${COMPONENT}`,
        "src/web/(platform)/welcome.page.tsx": `export const config = { route: "/welcome" };\n${COMPONENT}`,
      }),
    );
    const names = pagesOf(discoverPages({ appRoot, sites: SITES }))
      .filter((page) => page.site === "landing")
      .map((page) => page.routeName)
      .sort();

    expect(names).toEqual(["company.about", "landing.index", "landing.pricing", "landing.welcome"]);

    expect(
      pagesOf(discoverPages({ appRoot, sites: SITES }))
        .filter((page) => page.routePath === "/welcome")
        .map((page) => page.routeName)
        .sort(),
    ).toEqual(["landing.welcome", "platform.welcome"]);
  });

  it("prepends basePath to every path in that site", () => {
    const appRoot = makeAppTree(
      realEstate({ "src/web/(tenant-admin)/listings/[id].page.tsx": COMPONENT }),
    );
    const pages = pagesOf(
      discoverPages({
        appRoot,
        sites: { ...SITES, tenantAdmin: { ...SITES.tenantAdmin, basePath: "/admin" } },
      }),
    );

    expect(pages.filter((page) => page.site === "tenantAdmin").map((page) => page.routePath).sort()).toEqual([
      "/admin",
      "/admin/listings/:id",
    ]);
  });

  it("uses per-site 404 and error pages with a unique not-found name", () => {
    const appRoot = makeAppTree(
      realEstate({
        "src/web/(landing)/404.page.tsx": COMPONENT,
        "src/web/(platform)/404.page.tsx": COMPONENT,
        "src/web/(platform)/error.page.tsx": COMPONENT,
      }),
    );
    const all = discoverPages({ appRoot, sites: SITES });

    expect(pagesOf(all).filter((page) => page.routePath === "*").map((page) => page.routeName).sort()).toEqual([
      "landing.warlock.not-found",
      "platform.warlock.not-found",
    ]);
    expect(all.filter((page) => page.type === "error").map((page) => page.site)).toEqual(["platform"]);
  });

  it("throws on the same path twice inside one site", () => {
    const appRoot = makeAppTree(
      realEstate({ "src/web/(landing)/(a)/x.page.tsx": COMPONENT, "src/web/(landing)/x.page.tsx": COMPONENT }),
    );

    expect(() => discoverPages({ appRoot, sites: SITES })).toThrow(DuplicatePageRoutePathError);
  });

  it("throws on one explicit name used by two sites", () => {
    const appRoot = makeAppTree(
      realEstate({
        "src/web/(landing)/a.page.tsx": named("shared.name", "/a"),
        "src/web/(platform)/b.page.tsx": named("shared.name", "/b"),
      }),
    );

    expect(() => discoverPages({ appRoot, sites: SITES })).toThrow(DuplicatePageRouteNameError);
  });

  describe("boot errors", () => {
    it("rejects a top-level root.tsx", () => {
      const appRoot = makeAppTree(realEstate({ "src/web/root.tsx": COMPONENT }));

      expect(() => discoverPages({ appRoot, sites: SITES })).toThrow(/web\/root\.tsx/);
    });

    it("rejects an unassigned page but allows non-page files", () => {
      const ok = makeAppTree(realEstate({ "src/web/components/button.tsx": COMPONENT }));
      expect(() => discoverPages({ appRoot: ok, sites: SITES })).not.toThrow();

      const appRoot = makeAppTree(realEstate({ "src/web/stray.page.tsx": COMPONENT }));

      expect(() => discoverPages({ appRoot, sites: SITES })).toThrow(/stray\.page\.tsx.*unassigned/);
    });

    it("rejects a missing site folder and a missing root.tsx", () => {
      const files = realEstate();
      delete files["src/web/(tenant)/root.tsx"];
      delete files["src/web/(tenant)/index.page.tsx"];
      const appRoot = makeAppTree({ ...files, "src/web/(tenant)/keep.txt": "" });
      const missingFolder = makeAppTree(
        Object.fromEntries(Object.entries(files).filter(([file]) => !file.includes("(platform)"))),
      );

      expect(() => discoverPages({ appRoot, sites: SITES })).toThrow(/\(tenant\).*no root\.tsx/);
      expect(() => discoverPages({ appRoot: missingFolder, sites: SITES })).toThrow(
        /\(platform\).*does not exist/,
      );
    });

    it("rejects more than one 404 or error page in a site", () => {
      const appRoot = makeAppTree(
        realEstate({
          "src/web/(landing)/404.page.tsx": COMPONENT,
          "src/web/(landing)/help/404.page.tsx": COMPONENT,
          "src/web/(platform)/error.page.tsx": COMPONENT,
          "src/web/(platform)/x/error.page.tsx": COMPONENT,
        }),
      );

      expect(() => discoverPages({ appRoot, sites: SITES })).toThrow(/more than one 404[\s\S]*more than one error/);
    });

    it("reports every problem together", () => {
      const appRoot = makeAppTree(
        realEstate({ "src/web/root.tsx": COMPONENT, "src/web/stray.page.tsx": COMPONENT }),
      );

      expect(() => discoverPages({ appRoot, sites: SITES })).toThrow(
        /web\/root\.tsx[\s\S]*stray\.page\.tsx/,
      );
    });

    it("throws for an invalid sites config", () => {
      const appRoot = makeAppTree(realEstate());

      expect(() =>
        discoverPages({ appRoot, sites: { landing: { pages: "landing", hosts: ["a.app"] } } }),
      ).toThrow(/Invalid web\.sites/);
    });
  });

  it("leaves single-site output unchanged", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": COMPONENT,
      "src/web/index.page.tsx": COMPONENT,
      "src/web/(g)/pricing.page.tsx": COMPONENT,
      "src/web/404.page.tsx": COMPONENT,
    });
    const rel = (file: string) => path.relative(appRoot, file).split(path.sep).join("/");
    const snapshot = discoverPages({ appRoot }).map((page) => ({
      ...page,
      pageFile: rel(page.pageFile),
      webRoot: rel(page.webRoot),
      appFile: rel(page.appFile as string),
    }));

    expect(snapshot).toEqual([
      {
        type: "page",
        routeName: "pricing",
        routePath: "/pricing",
        pageFile: "src/web/(g)/pricing.page.tsx",
        webRoot: "src/web",
        layouts: [],
        layoutSetupFiles: [],
        middlewareLayouts: [],
        appFile: "src/web/root.tsx",
      },
      {
        type: "page",
        routeName: "warlock.not-found",
        routePath: "*",
        pageFile: "src/web/404.page.tsx",
        webRoot: "src/web",
        layouts: [],
        layoutSetupFiles: [],
        middlewareLayouts: [],
        appFile: "src/web/root.tsx",
      },
      {
        type: "page",
        routeName: "index",
        routePath: "/",
        pageFile: "src/web/index.page.tsx",
        webRoot: "src/web",
        layouts: [],
        layoutSetupFiles: [],
        middlewareLayouts: [],
        appFile: "src/web/root.tsx",
      },
    ]);
  });
});
