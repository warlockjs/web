import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router, container } from "@warlock.js/core";
import type { SitesConfig } from "../sites/site-config.types";
import {
  installPageRoutes,
  SITE_DISPATCH_SOURCE_FILE,
  type InstallPageRoutesOptions,
} from "./install-page-routes";
import { pageRouteSourceFiles } from "./page-route-reload";
import {
  createSiteDispatch,
  SITE_DISPATCH_GET_NAME,
  SITE_DISPATCH_POST_NAME,
} from "./site-dispatch";

const temporaryDirectories: string[] = [];
const router = Router.getInstance();

afterEach(() => {
  for (const route of router.list()) {
    if (route.sourceFile !== undefined) router.removeRoutesBySourceFile(route.sourceFile);
  }

  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }

  container.delete("http.server");
  vi.restoreAllMocks();
});

function makeFixture() {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-site-dispatch-reload-"));
  temporaryDirectories.push(appRoot);
  const appSrcRoot = path.join(appRoot, "src");
  const rootFile = path.join(appSrcRoot, "web", "$sites", "store", "root.tsx");
  const pageFile = path.join(appSrcRoot, "web", "$sites", "store", "index.page.tsx");

  fs.mkdirSync(path.dirname(pageFile), { recursive: true });
  fs.writeFileSync(rootFile, "export default function Root() { return null; }\n", "utf-8");
  fs.writeFileSync(pageFile, "export default function Page() { return null; }\n", "utf-8");

  return { appRoot, appSrcRoot, rootFile, pageFile };
}

describe("installPageRoutes multi-site dispatch reload", () => {
  it("owns dispatch catch-alls and replaces them during a dev page-route reinstall", async () => {
    const files = makeFixture();
    const sites: SitesConfig = { store: { hosts: ["store.test"] } };
    const dispatch = createSiteDispatch({ sites });
    const vite: InstallPageRoutesOptions["vite"] = {
      ssrLoadModule: vi.fn(async (id: string) => {
        if (id === files.rootFile || id === files.pageFile) return { default: () => null };

        throw new Error(`unexpected module: ${id}`);
      }),
    } as never;
    const install = () =>
      installPageRoutes({
        router,
        vite,
        appRoot: files.appRoot,
        appSrcRoot: files.appSrcRoot,
        appFile: path.join(files.appSrcRoot, "web", "root.tsx"),
        siteDispatch: { dispatch, sites },
      });

    container.set("http.server", { addHook: vi.fn() } as never);
    await install();

    const dispatchRoutes = () =>
      router
        .list()
        .filter(
          (route) =>
            route.name === SITE_DISPATCH_GET_NAME || route.name === SITE_DISPATCH_POST_NAME,
        );

    expect(dispatchRoutes()).toHaveLength(2);
    expect(dispatchRoutes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: SITE_DISPATCH_GET_NAME,
          sourceFile: SITE_DISPATCH_SOURCE_FILE,
        }),
        expect.objectContaining({
          name: SITE_DISPATCH_POST_NAME,
          sourceFile: SITE_DISPATCH_SOURCE_FILE,
        }),
      ]),
    );

    await expect(
      router.replaceRoutesBySourceFiles(pageRouteSourceFiles(router.list()), install),
    ).resolves.toBeDefined();

    expect(dispatchRoutes().filter((route) => route.name === SITE_DISPATCH_GET_NAME)).toHaveLength(
      1,
    );
    expect(dispatchRoutes().filter((route) => route.name === SITE_DISPATCH_POST_NAME)).toHaveLength(
      1,
    );
  });
});
