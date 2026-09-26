import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { container, requestContext as coreRequestContext, RouteRegistry, type Router } from "@warlock.js/core";
import { href, registerSiteRoutes, resetRouteTable } from "../routing/route-table";
import { connectCurrentSite, siteUrl } from "../routing/site-url";
import type { SitesConfig } from "../sites/site-config.types";
import * as createPageRouteHandlerModule from "./create-page-route-handler";
import type { PageRouteHandler, PageRouteHandlerOptions } from "./create-page-route-handler";
import { installPageRoutes } from "./install-page-routes";
import { installPageRoutesFromManifest } from "./install-page-routes-from-manifest";
import type { PageManifest, PageManifestPageEntry } from "./page-manifest";
import {
  createSiteDispatch,
  RESOLVED_SITE_SHARED,
  SITE_DISPATCH_ROUTE_PATH,
  type SiteDispatchInstall,
} from "./site-dispatch";

/**
 * Multi-site catch-all dispatch. The SAME fixtures run through the dev
 * installer (fake Vite, real filesystem discovery) and the production
 * installer (a manifest), and both must dispatch identically.
 */

const sites: SitesConfig = {
  a: { pages: "(a)", hosts: ["a.test"] },
  b: { pages: "(b)", hosts: ["b.test"] },
  admin: { pages: "(admin)", hosts: ["a.test"], basePath: "/admin" },
  tenant: { pages: "(tenant)", dynamic: true },
};

type Fixture = { site: string; file: string; route?: string };

const fixtures: Fixture[] = [
  { site: "a", file: "home", route: "/" },
  { site: "a", file: "product", route: "/products/:id" },
  { site: "b", file: "home", route: "/" },
  { site: "b", file: "404" },
  { site: "admin", file: "home", route: "/" },
  { site: "tenant", file: "home", route: "/" },
];

const resolveHost = vi.fn(async ({ host }: { host: string }) => {
  if (host === "t.test") return { site: "tenant", key: "tenant-1", shared: { tenant: "tenant-1" } };
  if (host === "boom.test") throw new Error("resolver exploded");

  return null;
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }

  vi.restoreAllMocks();
  container.delete("http.server");
  resetRouteTable();
  connectCurrentSite(undefined);
});

beforeEach(() => {
  container.set("http.server", { addHook: vi.fn() } as never);
});

const siteOf = (site: string) => `(${site})`;

function pageSource(fixture: Fixture): string {
  return fixture.route === undefined
    ? "export default function Page() { return null; }\n"
    : `export default function Page() { return null; }\nexport const config = { route: ${JSON.stringify(fixture.route)} };\n`;
}

/** One recorded page render. */
type Rendered = { page: string; params: Record<string, string>; site: unknown };

type RecordedRoutes = { path: string; method: "GET" | "POST"; handler: PageRouteHandler }[];

function recordingRouter() {
  const routes: RecordedRoutes = [];
  const router = {
    get: (routePath: string, handler: PageRouteHandler) => {
      routes.push({ path: routePath, method: "GET", handler });
    },
    post: (routePath: string, handler: PageRouteHandler) => {
      routes.push({ path: routePath, method: "POST", handler });
    },
    withSourceFile: async <T>(_file: string, callback: () => T | Promise<T>) => callback(),
    list: () => [],
  } as unknown as Router;

  return { router, routes };
}

/** `a/home`, `b/404`: the site folder and page file a handler was built for. */
function tagOf(pageFile: string): string {
  const match = /\(([a-z]+)\)[\\/]([\w]+)\.page\.tsx$/.exec(pageFile.replaceAll("\\", "/"));

  return match === null ? pageFile : `${match[1]}/${match[2]}`;
}

type Mode = "dev" | "prod";

/** Installs the shared fixtures in one mode and returns the dispatch route's GET handler. */
async function installFixtures(mode: Mode, rendered: Rendered[]) {
  const { router, routes } = recordingRouter();
  const dispatchInstall = (): SiteDispatchInstall => ({
    sites,
    dispatch: createSiteDispatch({ sites, resolveHost }),
  });
  const tagged = (options: PageRouteHandlerOptions): PageRouteHandler => {
    return async (context) => {
      rendered.push({
        page: tagOf(options.pageFile),
        params: { ...(context.request.params as Record<string, string>) },
        site: context.request.site,
      });
    };
  };

  if (mode === "dev") {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-site-dispatch-"));
    temporaryDirectories.push(appRoot);
    const modules: Record<string, unknown> = {};
    const write = (relative: string, contents: string, module: unknown) => {
      const full = path.join(appRoot, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, contents, "utf-8");
      modules[full] = module;
    };

    for (const key of Object.keys(sites)) {
      write(
        `src/web/${siteOf(key)}/root.tsx`,
        "export default function Root() { return null; }\n",
        { default: () => null },
      );
    }

    for (const fixture of fixtures) {
      write(
        `src/web/${siteOf(fixture.site)}/${fixture.file}.page.tsx`,
        pageSource(fixture),
        fixture.route === undefined
          ? { default: () => null }
          : { default: () => null, config: { route: fixture.route } },
      );
    }

    vi.spyOn(createPageRouteHandlerModule, "createPageRouteHandler").mockImplementation(tagged);

    await installPageRoutes({
      router,
      vite: {
        ssrLoadModule: async (id: string) => modules[id] ?? { default: () => null },
      } as never,
      appSrcRoot: path.join(appRoot, "src"),
      appFile: path.join(appRoot, "src/web/root.tsx"),
      siteDispatch: dispatchInstall(),
    });
  } else {
    const entry = (fixture: Fixture): PageManifestPageEntry => ({
      module:
        fixture.route === undefined
          ? { default: () => null }
          : { default: () => null, config: { route: fixture.route } },
      sourceFile: `src/web/${siteOf(fixture.site)}/${fixture.file}.page.tsx`,
      layouts: [],
      site: fixture.site,
    });
    const manifest: PageManifest = {
      pages: fixtures.map(entry),
      sites: Object.fromEntries(
        Object.keys(sites).map((key) => [
          key,
          {
            app: { module: { default: () => null }, sourceFile: `src/web/${siteOf(key)}/root.tsx` },
            hydrationEntry: `hydration-${key}`,
          },
        ]),
      ),
    };

    installPageRoutesFromManifest({
      router,
      manifest,
      createHandler: tagged,
      siteDispatch: dispatchInstall(),
    });
  }

  return routes;
}

function requestContext(host: string, requestPath: string, method: "GET" | "POST" = "GET") {
  const params: Record<string, string> = { "*": requestPath.slice(1) };
  const sent: { body: unknown; status?: number }[] = [];
  const request = {
    path: requestPath,
    method,
    protocol: "http",
    baseRequest: { hostname: host, params },
    params,
    setParam(key: string, value: string) {
      params[key] = value;

      return request;
    },
    site: undefined as unknown,
    locale: undefined as string | undefined,
    header: (name: string) =>
      name === "accept" ? "text/html" : name === "host" ? `${host}:2030` : undefined,
  };
  const response = {
    send: async (body: unknown, status?: number) => {
      sent.push({ body, status });
    },
    header: () => undefined,
    html: async (body: string, status?: number) => {
      sent.push({ body: "html", status });
    },
  };

  return { context: { request, response } as never, sent };
}

async function dispatchOf(routes: RecordedRoutes, method: "GET" | "POST" = "GET") {
  const route = routes.find((candidate) => candidate.method === method);

  if (route === undefined) throw new Error(`no ${method} dispatch route registered`);

  expect(route.path).toBe(SITE_DISPATCH_ROUTE_PATH);

  return route.handler;
}

describe.each<Mode>(["dev", "prod"])("multi-site dispatch (%s)", (mode) => {
  it("registers one catch-all per method and no per-page route", async () => {
    const routes = await installFixtures(mode, []);

    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      "GET /*",
      "POST /*",
    ]);
  });

  it("renders the same path on two hosts as two different sites' pages", async () => {
    const rendered: Rendered[] = [];
    const handler = await dispatchOf(await installFixtures(mode, rendered));

    await handler(requestContext("a.test", "/").context);
    await handler(requestContext("b.test", "/").context);

    expect(rendered.map((entry) => entry.page)).toEqual(["a/home", "b/home"]);
    expect(rendered.map((entry) => (entry.site as { key: string }).key)).toEqual(["a", "b"]);
  });

  it("matches a param route and sets params the way core does", async () => {
    const rendered: Rendered[] = [];
    const handler = await dispatchOf(await installFixtures(mode, rendered));
    const { context } = requestContext("a.test", "/products/42");

    await handler(context);

    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.page).toBe("a/product");
    expect(rendered[0]?.params).toEqual({ id: "42" });
  });

  it("answers an unknown host with the plain framework 404", async () => {
    const rendered: Rendered[] = [];
    const handler = await dispatchOf(await installFixtures(mode, rendered));
    const { context, sent } = requestContext("nobody.test", "/");

    await handler(context);

    expect(rendered).toEqual([]);
    expect(sent).toEqual([
      { body: { error: "Route not found", path: "/", method: "GET" }, status: 404 },
    ]);
  });

  it("lets a resolver throw reach the existing error path (500)", async () => {
    const handler = await dispatchOf(await installFixtures(mode, []));

    await expect(handler(requestContext("boom.test", "/").context)).rejects.toThrow(
      "resolver exploded",
    );
  });

  it("serves a resolver-selected site and records the tenant key", async () => {
    const rendered: Rendered[] = [];
    const handler = await dispatchOf(await installFixtures(mode, rendered));

    await handler(requestContext("t.test", "/").context);

    expect(rendered[0]?.page).toBe("tenant/home");
    expect(rendered[0]?.site).toEqual({
      key: "tenant",
      host: "t.test",
      basePath: "",
      tenantKey: "tenant-1",
    });
  });

  it("keeps resolver shared data in the internal request slot", async () => {
    const rendered: Rendered[] = [];
    const { router, routes } = recordingRouter();
    const dispatch = createSiteDispatch({ sites, resolveHost });
    dispatch.add("tenant", "GET", "/", async (context) => {
      rendered.push({ page: "tenant/home", params: {}, site: context.request.site });
    });
    dispatch.register(router);
    const handler = await dispatchOf(routes);
    const { context } = requestContext("t.test", "/");

    await handler(context);

    const request = (context as { request: Record<PropertyKey, unknown> }).request as {
      [RESOLVED_SITE_SHARED]?: { tenant?: string };
    };
    expect(request[RESOLVED_SITE_SHARED]).toEqual({ tenant: "tenant-1" });
    expect(Object.keys(request)).not.toContain("shared");
  });

  it("serves a basePath site under its prefix only", async () => {
    const rendered: Rendered[] = [];
    const handler = await dispatchOf(await installFixtures(mode, rendered));

    await handler(requestContext("a.test", "/admin").context);
    await handler(requestContext("a.test", "/admin/").context);

    expect(rendered.map((entry) => entry.page)).toEqual(["admin/home", "admin/home"]);
    expect((rendered[0]?.site as { basePath: string }).basePath).toBe("/admin");
  });

  it("falls back to the site's own not-found page, else the plain 404", async () => {
    const rendered: Rendered[] = [];
    const handler = await dispatchOf(await installFixtures(mode, rendered));
    const missingOnB = requestContext("b.test", "/missing");
    const missingOnA = requestContext("a.test", "/missing");

    await handler(missingOnB.context);
    await handler(missingOnA.context);

    expect(rendered.map((entry) => entry.page)).toEqual(["b/404"]);
    // No 404 page on site "a": the framework default document answers 404.
    expect(missingOnA.sent).toEqual([{ body: "html", status: 404 }]);
  });
});

describe("multi-site shadow guard", () => {
  it("rejects one boot error for a page hidden by an application route with renamed params", () => {
    const dispatch = createSiteDispatch({ sites: { landing: { pages: "(landing)", hosts: ["a.test"] } } });
    dispatch.add("landing", "GET", "/products/:id", vi.fn() as never, "src/web/(landing)/product.page.tsx");
    const router = {
      list: () => [{ isPage: false, method: "GET", path: "/products/:slug" }],
      get: vi.fn(),
      post: vi.fn(),
    } as unknown as Router;

    expect(() => dispatch.register(router)).toThrow(
      "src/web/(landing)/product.page.tsx is shadowed by application route GET /products/:slug: this page can never be reached.",
    );
  });
});

describe("dev and prod dispatch identically over the same fixtures", () => {
  const probes: [string, string][] = [
    ["a.test", "/"],
    ["b.test", "/"],
    ["a.test", "/products/7"],
    ["a.test", "/admin"],
    ["t.test", "/"],
    ["b.test", "/missing"],
    ["nobody.test", "/"],
  ];

  it("produces the same page, params and site for every probe", async () => {
    const outcomes: Record<Mode, unknown[]> = { dev: [], prod: [] };

    for (const mode of ["dev", "prod"] as const) {
      const rendered: Rendered[] = [];
      const handler = await dispatchOf(await installFixtures(mode, rendered));

      for (const [host, probePath] of probes) {
        const before = rendered.length;
        const { context, sent } = requestContext(host, probePath);

        await handler(context);
        outcomes[mode].push({ rendered: rendered.slice(before), sent });
      }
    }

    expect(outcomes.dev).toEqual(outcomes.prod);
  });
});

describe("site URL dispatch integration", () => {
  it("connects site URL helpers to the dispatched request site", async () => {
    const { router, routes } = recordingRouter();
    const dispatch = createSiteDispatch({ sites, resolveHost });
    let urls: { site: string; other: string } | undefined;
    dispatch.add("a", "GET", "/", async () => {
      urls = { site: siteUrl(), other: href("b.home") };
    });
    dispatch.register(router);
    registerSiteRoutes("a", [{ name: "a.home", path: "/" }], sites);
    registerSiteRoutes("b", [{ name: "b.home", path: "/" }], sites);
    const context = requestContext("a.test", "/").context;

    // `context` is `{ request, response }` typed as `never` by requestContext().
    await coreRequestContext.run(context, () =>
      dispatchOf(routes).then((handler) => handler(context)),
    );

    expect(urls).toEqual({
      site: "http://a.test:2030",
      other: "http://b.test:2030/",
    });
  });
});

describe("app routes beat the dispatch", () => {
  it("core matches the catch-all only when no app route matches", () => {
    const registry = new RouteRegistry();
    const appHandler = async () => undefined;
    const dispatchHandler = async () => undefined;

    registry.register([
      { method: "GET", path: "/", handler: appHandler, name: "app.home" },
      { method: "GET", path: "/api/users/:id", handler: appHandler, name: "app.user" },
      { method: "GET", path: SITE_DISPATCH_ROUTE_PATH, handler: dispatchHandler, name: "dispatch" },
    ] as never);

    expect(registry.find("GET", "/")?.route.name).toBe("app.home");
    expect(registry.find("GET", "/api/users/9")?.route.name).toBe("app.user");
    expect(registry.find("GET", "/somewhere/else")?.route.name).toBe("dispatch");
    expect(registry.find("GET", "/products/42?x=1")?.route.name).toBe("dispatch");
  });
});

describe("single-site mode", () => {
  it("still registers each page on its own route, with no dispatch", async () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-single-site-"));
    temporaryDirectories.push(appRoot);
    const home = path.join(appRoot, "src/web/home.page.tsx");

    fs.mkdirSync(path.dirname(home), { recursive: true });
    fs.writeFileSync(home, pageSource({ site: "", file: "home", route: "/" }), "utf-8");
    fs.writeFileSync(
      path.join(appRoot, "src/web/root.tsx"),
      "export default function Root() { return null; }\n",
      "utf-8",
    );

    const { router, routes } = recordingRouter();

    vi.spyOn(createPageRouteHandlerModule, "createPageRouteHandler").mockImplementation(
      () => async () => undefined,
    );

    await installPageRoutes({
      router,
      vite: {
        ssrLoadModule: async (id: string) =>
          id === home ? { default: () => null, config: { route: "/" } } : { default: () => null },
      } as never,
      appSrcRoot: path.join(appRoot, "src"),
      appFile: path.join(appRoot, "src/web/root.tsx"),
    });

    const registered = routes.map((route) => `${route.method} ${route.path}`);

    expect(registered).toContain("GET /");
    expect(registered).not.toContain("GET /*");
  });
});

describe("resolver shared hand-off across module copies", () => {
  it("uses one registry symbol, so Vite's SSR copy of the page pipeline finds it", async () => {
    const { RESOLVED_SITE_SHARED: first } = await import("./site-dispatch");
    vi.resetModules();
    const { RESOLVED_SITE_SHARED: second } = await import("./site-dispatch");

    expect(second).toBe(first);
  });
});
