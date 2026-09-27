import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Application, resetRolesCacheForTests } from "@warlock.js/core";
import {
  installPageRoutesFromManifest,
  type InstallPageRoutesFromManifestOptions,
} from "./install-page-routes-from-manifest";
import type { PageRouteHandler, PageRouteHandlerOptions } from "./create-page-route-handler";
import type { PageManifest } from "./page-manifest";
import { NOT_FOUND_ROUTE_PATH } from "./not-found-page";

/**
 * `--sites` (`WARLOCK_SITES`) narrows a production multi-site install to the
 * listed site keys — decision 5, `releases/5.25-deploy-in-parts-design.md`.
 * Fixture mirrors `install-page-routes-from-manifest.spec.ts`'s own
 * "each site's own error boundary" case: two real sites, `landing` and
 * `platform`.
 */

function recordingRouter() {
  const registered: { path: string }[] = [];
  const notFound: { path: string }[] = [];

  const router = {
    get(path: string) {
      (path === NOT_FOUND_ROUTE_PATH ? notFound : registered).push({ path });
    },
    list: () => [...registered, ...notFound].map((route) => ({ path: route.path })),
  } as unknown as InstallPageRoutesFromManifestOptions["router"];

  return { router, registered, notFound };
}

function recordingHandlerFactory() {
  const built: PageRouteHandlerOptions[] = [];

  const createHandler = (options: PageRouteHandlerOptions): PageRouteHandler => {
    built.push(options);

    return async () => undefined;
  };

  return { createHandler, built };
}

const appModule = { default: () => null };
const homeLayout = {
  module: { default: () => null, config: { prefix: "/" } },
  sourceFile: "src/web/main/layout.tsx",
};

function twoSiteManifest(): PageManifest {
  const landingPage = {
    module: { default: () => null, config: { route: "/" } },
    sourceFile: "src/web/$sites/landing/index.page.tsx",
    layouts: [homeLayout],
    site: "landing",
  };
  const platformPage = {
    module: { default: () => null, config: { route: { path: "/", name: "platform.index" } } },
    sourceFile: "src/web/$sites/platform/index.page.tsx",
    layouts: [homeLayout],
    site: "platform",
  };

  return {
    pages: [landingPage, platformPage],
    sites: {
      landing: { app: { module: appModule, sourceFile: "src/web/$sites/landing/root.tsx" } },
      platform: { app: { module: appModule, sourceFile: "src/web/$sites/platform/root.tsx" } },
    },
  };
}

function fakeDispatch() {
  const added: string[] = [];

  return {
    dispatch: {
      add: (site: string) => added.push(site),
      setNotFound: () => undefined,
      register: () => undefined,
    },
    added,
  };
}

beforeEach(() => {
  resetRolesCacheForTests();
});

afterEach(() => {
  delete process.env.WARLOCK_SITES;
  resetRolesCacheForTests();
  vi.restoreAllMocks();
});

describe("installPageRoutesFromManifest --sites filter", () => {
  it("installs only the listed site's pages, leaving the other site's pages unbuilt", () => {
    process.env.WARLOCK_SITES = "landing";
    const { router } = recordingRouter();
    const { createHandler, built } = recordingHandlerFactory();
    const { dispatch, added } = fakeDispatch();

    installPageRoutesFromManifest({
      router,
      createHandler,
      manifest: twoSiteManifest(),
      siteDispatch: {
        dispatch,
        sites: {
          landing: { hosts: ["landing.test"] },
          platform: { hosts: ["platform.test"] },
        },
      },
    });

    expect(added).toEqual(["landing"]);
    expect(built.map((options) => options.pageFile)).toEqual([
      "src/web/$sites/landing/index.page.tsx",
    ]);
  });

  it("installs every site when Application.sites is unset (no env, unchanged)", () => {
    const { router } = recordingRouter();
    const { createHandler, built } = recordingHandlerFactory();
    const { dispatch, added } = fakeDispatch();

    installPageRoutesFromManifest({
      router,
      createHandler,
      manifest: twoSiteManifest(),
      siteDispatch: {
        dispatch,
        sites: {
          landing: { hosts: ["landing.test"] },
          platform: { hosts: ["platform.test"] },
        },
      },
    });

    expect(added.sort()).toEqual(["landing", "platform"]);
    expect(built).toHaveLength(2);
  });

  it("throws naming the valid keys when --sites names a key absent from web.sites", () => {
    process.env.WARLOCK_SITES = "nope";
    const { router } = recordingRouter();
    const { createHandler } = recordingHandlerFactory();
    const { dispatch } = fakeDispatch();

    expect(() =>
      installPageRoutesFromManifest({
        router,
        createHandler,
        manifest: twoSiteManifest(),
        siteDispatch: {
          dispatch,
          sites: {
            landing: { hosts: ["landing.test"] },
            platform: { hosts: ["platform.test"] },
          },
        },
      }),
    ).toThrowError(/unknown site key.*nope.*landing, platform/is);
  });
});
