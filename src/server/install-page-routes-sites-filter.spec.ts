import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Application, Router, container, resetRolesCacheForTests } from "@warlock.js/core";
import type { SitesConfig } from "../sites/site-config.types";
import { installPageRoutes, type InstallPageRoutesOptions } from "./install-page-routes";
import { createSiteDispatch } from "./site-dispatch";

/**
 * `--sites` (`WARLOCK_SITES`) narrows dev's multi-site install to the listed
 * site keys, leaving the rest of `web.sites` on disk but unregistered —
 * decision 5, `releases/5.25-deploy-in-parts-design.md`. Both sites exist on
 * disk in every case below; only the env var changes.
 */

const temporaryDirectories: string[] = [];
const router = Router.getInstance();

beforeEach(() => {
  resetRolesCacheForTests();
});

afterEach(() => {
  for (const route of router.list()) {
    if (route.sourceFile !== undefined) router.removeRoutesBySourceFile(route.sourceFile);
  }

  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }

  container.delete("http.server");
  delete process.env.WARLOCK_SITES;
  resetRolesCacheForTests();
  vi.restoreAllMocks();
});

function makeFixture() {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-sites-filter-"));
  temporaryDirectories.push(appRoot);
  const appSrcRoot = path.join(appRoot, "src");

  const files = {
    storeRoot: path.join(appSrcRoot, "web", "$sites", "store", "root.tsx"),
    storePage: path.join(appSrcRoot, "web", "$sites", "store", "index.page.tsx"),
    otherRoot: path.join(appSrcRoot, "web", "$sites", "other", "root.tsx"),
    otherPage: path.join(appSrcRoot, "web", "$sites", "other", "index.page.tsx"),
  };

  for (const file of Object.values(files)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "export default function Page() { return null; }\n", "utf-8");
  }

  return { appRoot, appSrcRoot, ...files };
}

function install(files: ReturnType<typeof makeFixture>, sites: SitesConfig) {
  const dispatch = createSiteDispatch({ sites });
  const vite: InstallPageRoutesOptions["vite"] = {
    ssrLoadModule: vi.fn(async (id: string) => {
      if (Object.values(files).includes(id)) return { default: () => null };

      throw new Error(`unexpected module: ${id}`);
    }),
  } as never;

  container.set("http.server", { addHook: vi.fn() } as never);

  return installPageRoutes({
    router,
    vite,
    appRoot: files.appRoot,
    appSrcRoot: files.appSrcRoot,
    appFile: path.join(files.appSrcRoot, "web", "root.tsx"),
    siteDispatch: { dispatch, sites },
  });
}

describe("installPageRoutes --sites filter", () => {
  it("registers only the listed site's pages", async () => {
    process.env.WARLOCK_SITES = "store";
    const files = makeFixture();
    const sites: SitesConfig = {
      store: { hosts: ["store.test"] },
      other: { hosts: ["other.test"] },
    };

    const installed = await install(files, sites);

    expect(installed.map((page) => page.file)).toEqual([files.storePage]);
  });

  it("registers every site when Application.sites is unset (no env, unchanged)", async () => {
    const files = makeFixture();
    const sites: SitesConfig = {
      store: { hosts: ["store.test"] },
      other: { hosts: ["other.test"] },
    };

    const installed = await install(files, sites);

    expect(installed.map((page) => page.file).sort()).toEqual(
      [files.otherPage, files.storePage].sort(),
    );
  });

  it("throws naming the valid keys when --sites names a key absent from web.sites", async () => {
    process.env.WARLOCK_SITES = "nope";
    const files = makeFixture();
    const sites: SitesConfig = {
      store: { hosts: ["store.test"] },
      other: { hosts: ["other.test"] },
    };

    await expect(install(files, sites)).rejects.toThrowError(
      /unknown site key.*nope.*store, other/is,
    );
  });
});
