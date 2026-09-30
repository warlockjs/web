import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverPages, isDiscoveredRoutablePage } from "./discover-pages";
import { discoverPageRoutes } from "./generate-pages-barrel";
import { generateRouteTypes } from "./generate-route-types";
import { readPageGuard } from "./read-page-guard";

const temporaryDirectories: string[] = [];

function makeAppTree(files: Record<string, string>): string {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-guard-"));
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

const SESSION_IMPORT = 'import { requireUser, requireGuest } from "@warlock.js/web/session";\n';
const GUARD = `${SESSION_IMPORT}export const config = { middleware: [requireUser()] };\n`;
const APP = "export default function App() { return null; }\n";
const LAYOUT = "export default function Layout() { return null; }\n";
const page = (declaration = "") =>
  `${declaration}\nexport default function Page() { return null; }\n`;

function routablePages(appRoot: string) {
  return discoverPages({ appRoot }).filter(isDiscoveredRoutablePage);
}

function guardOf(appRoot: string): Record<string, "user" | undefined> {
  return Object.fromEntries(routablePages(appRoot).map((entry) => [entry.routeName, entry.guard]));
}

describe("discoverPages guard", () => {
  it("marks a page that guards itself, and nothing else", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/account.page.tsx": page(GUARD),
      "src/web/about.page.tsx": page("export const config = { middleware: [audit] };"),
    });

    expect(guardOf(appRoot)).toMatchObject({ account: "user", about: undefined });
  });

  it("honours an aliased requireUser import", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/account.page.tsx": page(
        'import { requireUser as ru } from "@warlock.js/web/session";\nexport const config = { middleware: [ru()] };',
      ),
    });

    expect(guardOf(appRoot).account).toBe("user");
  });

  it.each([
    ["a spread", "export const config = { middleware: [...shared] };"],
    ["an identifier", "const g = requireUser();\nexport const config = { middleware: [g] };"],
    ["a conditional", "export const config = { middleware: [on ? requireUser() : audit] };"],
    ["a wrapper call", "export const config = { middleware: [wrap(requireUser())] };"],
    ["requireGuest()", "export const config = { middleware: [requireGuest()] };"],
    ["action-only middleware", "export const config = { action: { middleware: [requireUser()] } };"],
  ])("does not treat %s as a guard", (_case, declaration) => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/account.page.tsx": page(`${SESSION_IMPORT}${declaration}`),
    });

    expect(guardOf(appRoot).account).toBeUndefined();
  });

  it("inherits a guard from a layout anywhere on the chain", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/account/layout.tsx": `${GUARD}${LAYOUT}`,
      "src/web/account/profile.page.tsx": page(),
      "src/web/account/settings/index.page.tsx": page(),
      "src/web/public/home.page.tsx": page(),
    });
    const guards = guardOf(appRoot);

    expect(Object.values(guards)).toHaveLength(3);
    expect(Object.values(guards).filter((guard) => guard === "user")).toHaveLength(2);
    expect(guards["public.home"]).toBeUndefined();
  });

  it("inherits a guard from a non-rendering layout", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/admin/layout.tsx": GUARD,
      "src/web/admin/users.page.tsx": page(),
    });

    expect(Object.values(guardOf(appRoot))).toEqual(["user"]);
  });

  it("guards every page when the root guards, but never the not-found page", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": `${GUARD}${APP}`,
      "src/web/home.page.tsx": page(),
      "src/web/404.page.tsx": page(),
    });
    const pages = routablePages(appRoot);
    const notFound = pages.find((entry) => entry.pageFile.endsWith("404.page.tsx"));

    expect(pages.find((entry) => entry.routeName === "home")?.guard).toBe("user");
    expect(notFound).toBeDefined();
    expect(notFound).not.toHaveProperty("guard");

    const manifest = discoverPageRoutes({ appRoot }).routes;

    expect(manifest.find((route) => route.name === "home")?.guard).toBe("user");
    expect(manifest.at(-1)).not.toHaveProperty("guard");
  });

  it("reads the guard from a setup companion's config", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/account.page.tsx": page(),
      "src/web/account.setup.ts": GUARD,
      "src/web/group/layout.tsx": LAYOUT,
      "src/web/group/layout.setup.ts": GUARD,
      "src/web/group/inner.page.tsx": page(),
    });
    const guards = guardOf(appRoot);

    expect(guards.account).toBe("user");
    expect(Object.values(guards).every((guard) => guard === "user")).toBe(true);
    expect(Object.values(guards)).toHaveLength(2);
  });

  it("carries the guard into the manifest and the generated registry", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/account.page.tsx": page(
        `${SESSION_IMPORT}export const config = { route: { path: "/account", name: "account.show" }, middleware: [requireUser()], actions: { save: {} } };\nexport const actions = { save() {} };`,
      ),
      "src/web/about.page.tsx": page(),
    });
    const { routes } = discoverPageRoutes({ appRoot });
    const output = generateRouteTypes({ pages: routes, apiRoutes: [] });

    expect(output).toContain(
      '"account.show": { path: "/account"; params: {}; actions: "save"; guard: "user" };',
    );
    expect(output).toMatch(/"about": \{ path: "\/about"; params: \{\} \};/);
  });

  it("emits byte-identical output for an app with no guard", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/about.page.tsx": page(),
      "src/web/blog/index.page.tsx": page(),
    });
    const { routes } = discoverPageRoutes({ appRoot });
    const output = generateRouteTypes({ pages: routes, apiRoutes: [] });
    const withoutGuardKey = generateRouteTypes({
      pages: routes.map(({ guard: _guard, ...rest }) => rest),
      apiRoutes: [],
    });

    expect(routes.every((route) => !("guard" in route))).toBe(true);
    expect(output).not.toContain("guard");
    expect(output).toBe(withoutGuardKey);
  });
});

describe("readPageGuard (dev installer)", () => {
  it("applies the same rule to a page, its layouts and the root", () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/plain/layout.tsx": LAYOUT,
      "src/web/plain/a.page.tsx": page(),
      "src/web/guarded/layout.tsx": `${GUARD}${LAYOUT}`,
      "src/web/guarded/b.page.tsx": page(),
      "src/web/own.page.tsx": page(GUARD),
      "src/web/broken.page.tsx": "this is not ( valid",
    });
    const web = path.join(appRoot, "src/web");
    const root = path.join(web, "root.tsx");

    expect(
      readPageGuard({
        pageFile: path.join(web, "plain/a.page.tsx"),
        layouts: [path.join(web, "plain/layout.tsx")],
        appFile: root,
      }),
    ).toBeUndefined();
    expect(
      readPageGuard({
        pageFile: path.join(web, "guarded/b.page.tsx"),
        layouts: [path.join(web, "guarded/layout.tsx")],
        appFile: root,
      }),
    ).toBe("user");
    expect(readPageGuard({ pageFile: path.join(web, "own.page.tsx"), layouts: [] })).toBe("user");
    expect(readPageGuard({ pageFile: path.join(web, "broken.page.tsx"), layouts: [] })).toBeUndefined();
  });
});
