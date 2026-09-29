/**
 * `ctx.route` through the REAL `web.sites` dispatch path: a real Fastify
 * instance (`server.inject`, no port), core's real router holding only the
 * `/*` catch-all per method, the real site dispatcher choosing the page, and
 * the real page handler + pipeline running the loaders. Complements
 * `execute-page-request-route.spec.ts`, which hand-builds the entry and the
 * request.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { container, registerHttpPlugins, router } from "@warlock.js/core";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resetRouteTable } from "../routing/route-table";
import type { SitesConfig } from "../sites/site-config.types";
import { connectPageContext } from "./execute-page-request";
import type { PipelineStore } from "./execute-page-request.types";
import { installPageRoutesFromManifest } from "./install-page-routes-from-manifest";
import type { PageRouteHandlerOptions } from "./create-page-route-handler";
import type { PageManifest, PageManifestPageEntry } from "./page-manifest";
import { createSiteDispatch } from "./site-dispatch";

vi.mock("../shared", () => ({
  enterSharedScope: vi.fn(),
  sealShared: vi.fn(async () => Object.freeze({})),
}));

const sites: SitesConfig = {
  a: { hosts: ["a.test"] },
  b: { hosts: ["b.test"] },
};

type Seen = { level: string; site: string; route: unknown };

const seen: Seen[] = [];

function pageOf(
  site: string,
  file: string,
  route: string | { path: string; name: string },
): PageManifestPageEntry {
  const layout = {
    module: {
      default: () => null,
      config: { prefix: "/" },
      loader: (ctx: { route: unknown }) => {
        seen.push({ level: "layout", site, route: ctx.route });

        return {};
      },
    },
    sourceFile: `src/web/$sites/${site}/layout.tsx`,
  };

  return {
    module: {
      default: () => null,
      config: { route },
      loader: (ctx: { route: unknown }) => {
        seen.push({ level: "page", site, route: ctx.route });

        return {};
      },
    },
    sourceFile: `src/web/$sites/${site}/${file}.page.tsx`,
    layouts: [layout],
    site,
  };
}

function manifestOf(): PageManifest {
  return {
    pages: [
      pageOf("a", "about", { path: "/about", name: "about" }),
      pageOf("a", "contact", "/contact"),
      pageOf("b", "about", { path: "/about", name: "b-about" }),
    ],
    sites: Object.fromEntries(
      Object.keys(sites).map((key) => [
        key,
        {
          app: { module: { default: () => null }, sourceFile: `src/web/$sites/${key}/root.tsx` },
          hydrationEntry: `hydration-${key}`,
        },
      ]),
    ),
  };
}

/** The entry name each page gets when installed WITHOUT sites (the baseline). */
function nonSitesNames(): Record<string, string> {
  const names: Record<string, string> = {};
  const routes: unknown[] = [];
  const recordingRouter = {
    get: (_path: string, _handler: unknown) => routes.push(_path),
    post: (_path: string, _handler: unknown) => routes.push(_path),
    withSourceFile: async <T>(_file: string, callback: () => T | Promise<T>) => callback(),
    list: () => [],
  } as never;
  const { sites: _sites, ...rest } = manifestOf();
  const pages = manifestOf().pages.filter((page) => page.site === "a");

  installPageRoutesFromManifest({
    router: recordingRouter,
    manifest: {
      ...rest,
      app: { module: { default: () => null }, sourceFile: "src/web/root.tsx" },
      pages: pages.map(({ site: _site, ...page }) => page),
    },
    createHandler: (options: PageRouteHandlerOptions) => {
      names[options.path] = options.name;

      return async () => undefined;
    },
  });

  return names;
}

describe("ctx.route through real site dispatch", () => {
  const server = Fastify();
  let baseline: Record<string, string>;

  beforeAll(async () => {
    const store = new AsyncLocalStorage<PipelineStore>();

    connectPageContext({
      buildStore: (payload) => payload as never,
      getStore: () => store.getStore(),
      run: (value, callback) => store.run(value, callback),
    });
    await registerHttpPlugins(server);

    container.set("http.server", server as never);
    baseline = nonSitesNames();
    resetRouteTable();

    installPageRoutesFromManifest({
      router,
      manifest: manifestOf(),
      siteDispatch: { sites, dispatch: createSiteDispatch({ sites }) },
    });

    router.scan(server);
    await server.ready();
  });

  afterAll(async () => {
    container.delete("http.server");
    await server.close();
  });

  async function visit(host: string, url: string) {
    seen.length = 0;

    const response = await server.inject({ method: "GET", url, headers: { host } });

    return response;
  }

  it("registers only the catch-all, so request.route is not the page's route", () => {
    const paths = router
      .list()
      .filter((route) => route.method === "GET")
      .map((route) => route.path);

    expect(paths).toContain("/*");
    expect(paths).not.toContain("/about");
  });

  it("gives page and layout loaders the declared name and the page path", async () => {
    const response = await visit("a.test", "/about");

    expect(response.statusCode).toBe(200);
    expect(seen.map((item) => item.level).sort()).toEqual(["layout", "page"]);
    expect(seen.every((item) => item.site === "a")).toBe(true);

    for (const item of seen) {
      expect(item.route).toEqual({ name: "about", path: "/about", params: {} });
    }
  });

  it("gives an undeclared name the same generated name the page has without sites", async () => {
    const response = await visit("a.test", "/contact");
    const generated = baseline["/contact"];

    expect(response.statusCode).toBe(200);
    expect(generated).toBeDefined();
    expect(generated!.startsWith("a.")).toBe(false);
    expect(seen).toHaveLength(2);

    for (const item of seen) {
      expect(item.route).toEqual({ name: generated, path: "/contact", params: {} });
    }
  });
});
