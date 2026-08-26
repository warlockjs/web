import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Router } from "@warlock.js/core";
import type { ViteDevServer } from "vite";
import type { InstalledPageRoute } from "./install-page-routes";
import {
  pageRouteSourceFiles,
  pageRoutesNeedReplacement,
  registeredPageFiles,
} from "./page-route-reload";

const appRoot = path.resolve("fixture-app");
const appSrcRoot = path.join(appRoot, "src");
const pageFile = path.join(appSrcRoot, "web", "settings.page.tsx");

function installed(overrides: Partial<InstalledPageRoute> = {}): InstalledPageRoute {
  return {
    declaredPath: "/settings",
    path: "/admin/settings",
    name: "settings",
    file: pageFile,
    layoutFile: path.join(appSrcRoot, "web", "layout.tsx"),
    ...overrides,
  };
}

function fakeVite(pageModule: unknown) {
  const onFileChange = vi.fn();
  const ssrLoadModule = vi.fn(async () => pageModule);
  const vite = {
    environments: { ssr: { moduleGraph: { onFileChange } } },
    ssrLoadModule,
  } as unknown as ViteDevServer;

  return { vite, onFileChange, ssrLoadModule };
}

describe("pageRoutesNeedReplacement", () => {
  it("treats add/remove as definite graph changes without evaluating modules", async () => {
    const harness = fakeVite({ route: "/settings" });

    await expect(
      pageRoutesNeedReplacement(
        { added: [pageFile], removed: [], inspectionNeeded: [] },
        { vite: harness.vite, appSrcRoot, installedPages: [] },
      ),
    ).resolves.toBe(true);

    expect(harness.onFileChange).not.toHaveBeenCalled();
    expect(harness.ssrLoadModule).not.toHaveBeenCalled();
  });

  it("invalidates before loading but keeps a semantically equal route edit in HMR", async () => {
    const order: string[] = [];
    const harness = fakeVite({ route: { path: "/settings" } });
    harness.onFileChange.mockImplementation(() => order.push("invalidate"));
    harness.ssrLoadModule.mockImplementation(async () => {
      order.push("load");
      return { route: { path: "/settings" } };
    });

    await expect(
      pageRoutesNeedReplacement(
        { added: [], removed: [], inspectionNeeded: [pageFile] },
        { vite: harness.vite, appSrcRoot, installedPages: [installed()] },
      ),
    ).resolves.toBe(false);

    expect(order).toEqual(["invalidate", "load"]);
  });

  it("refreshes edited SSR modules even when add/remove already requires replacement", async () => {
    const harness = fakeVite({ route: "/settings" });

    await expect(
      pageRoutesNeedReplacement(
        { added: [path.join(appSrcRoot, "web", "new.page.tsx")], removed: [], inspectionNeeded: [pageFile] },
        { vite: harness.vite, appSrcRoot, installedPages: [installed()] },
      ),
    ).resolves.toBe(true);

    expect(harness.onFileChange).toHaveBeenCalledWith(pageFile);
    expect(harness.ssrLoadModule).toHaveBeenCalledWith(pageFile);
  });

  it.each([
    ["declared path", { route: "/profile" }],
    ["resolved name", { route: { path: "/settings", name: "account.settings" } }],
    ["missing route", { default: () => null }],
  ])("requests replacement for a changed %s", async (_label, pageModule) => {
    const harness = fakeVite(pageModule);

    await expect(
      pageRoutesNeedReplacement(
        { added: [], removed: [], inspectionNeeded: [pageFile] },
        { vite: harness.vite, appSrcRoot, installedPages: [installed()] },
      ),
    ).resolves.toBe(true);
  });

  it("keeps a valid custom 404 body edit in HMR and inspects an illegal route export", async () => {
    const notFoundFile = path.join(appSrcRoot, "web", "404.page.tsx");
    const valid = fakeVite({ default: () => null });
    const invalid = fakeVite({ route: "/404", default: () => null });
    const changes = { added: [], removed: [], inspectionNeeded: [notFoundFile] };

    await expect(
      pageRoutesNeedReplacement(changes, {
        vite: valid.vite,
        appSrcRoot,
        installedPages: [],
      }),
    ).resolves.toBe(false);
    await expect(
      pageRoutesNeedReplacement(changes, {
        vite: invalid.vite,
        appSrcRoot,
        installedPages: [],
      }),
    ).resolves.toBe(true);
  });
});

describe("page route ownership helpers", () => {
  const routes = [
    { isPage: false, sourceFile: "src/app/main/routes.ts" },
    { isPage: true, sourceFile: "src/web/home.page.tsx" },
    { isPage: true, sourceFile: "\0warlock:framework-default-404" },
  ] as ReturnType<Router["list"]>;

  it("maps only real page owners back to absolute page files", () => {
    expect(registeredPageFiles(routes, appSrcRoot)).toEqual([
      path.join(appSrcRoot, "web", "home.page.tsx"),
    ]);
  });

  it("keeps both real and synthetic page owners for atomic replacement", () => {
    expect(pageRouteSourceFiles(routes)).toEqual([
      "src/web/home.page.tsx",
      "\0warlock:framework-default-404",
    ]);
  });
});
