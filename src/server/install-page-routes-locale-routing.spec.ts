import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import config from "@mongez/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpContext, Router } from "@warlock.js/core";
import * as createPageRouteHandlerModule from "./create-page-route-handler";
import type { PageRouteHandler, PageRouteHandlerOptions } from "./create-page-route-handler";
import { installPageRoutes, type InstallPageRoutesOptions } from "./install-page-routes";
import { NOT_FOUND_ROUTE_PATH } from "./not-found-page";
import { LocaleParamRoutingConflictError } from "./locale-routing/locale-param-routing-conflict";

/**
 * Card A of `releases/v5.17-locale-routing-design-note.md` — `web.localeRouting`.
 * Proves dev's installer registers the locale-prefixed and redirect routes
 * the design note describes, and that production's manifest installer
 * (`install-page-routes-from-manifest-locale-routing.spec.ts`) agrees on
 * every one of them.
 */

const temporaryDirectories: string[] = [];

function makeAppTree(files: Record<string, string>): string {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-install-page-routes-locale-"));
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

  config.set("web", {});
  config.set("app", {});
  vi.restoreAllMocks();
});

type RegisteredRoute = {
  path: string;
  options: { name?: string; isPage?: boolean };
  handler: PageRouteHandler;
};

function recordingRouter() {
  const registered: RegisteredRoute[] = [];
  const notFound: RegisteredRoute[] = [];

  const router = {
    get(routePath: string, handler: PageRouteHandler, options: RegisteredRoute["options"]) {
      (routePath === NOT_FOUND_ROUTE_PATH ? notFound : registered).push({
        path: routePath,
        options,
        handler,
      });

      return router;
    },
    async withSourceFile<T>(_file: string, callback: () => T | Promise<T>) {
      return await callback();
    },
    removeRoutesBySourceFile() {},
  } as unknown as Router;

  return { router, registered, notFound };
}

function fakeVite(moduleByFile: Record<string, unknown>): InstallPageRoutesOptions["vite"] {
  return {
    ssrLoadModule: vi.fn(async (id: string) => {
      const found = moduleByFile[id];

      if (found === undefined && /[\\/]web[\\/]root\.tsx$/.test(id)) {
        return { default: () => null };
      }

      if (found === undefined) throw new Error(`fakeVite: no module registered for "${id}"`);

      return found;
    }),
  } as unknown as InstallPageRoutesOptions["vite"];
}

function pageModule(config: Record<string, unknown> = {}) {
  return { config, default: () => null };
}

function install(appSrcRoot: string, vite: InstallPageRoutesOptions["vite"]) {
  const { router, registered, notFound } = recordingRouter();

  const run = () =>
    installPageRoutes({ router, vite, appSrcRoot, appFile: path.join(appSrcRoot, "web/root.tsx") });

  return { run, router, registered, notFound };
}

/** Stubs `createPageRouteHandler` with a no-op handler — this file tests the wrapping, not a render. */
function stubPageRouteHandler(): void {
  vi.spyOn(createPageRouteHandlerModule, "createPageRouteHandler").mockImplementation(
    (): PageRouteHandler => async () => undefined,
  );
}

function fakeResponse() {
  const calls: { redirect?: [string, number]; permanentRedirect?: string } = {};

  return {
    calls,
    redirect(url: string, statusCode = 302) {
      calls.redirect = [url, statusCode];

      return this;
    },
    permanentRedirect(url: string) {
      calls.permanentRedirect = url;

      return this;
    },
  };
}

/** `path` is Fastify's raw `request.url` shape: `pathname` plus `?search`, verbatim. */
function fakeRequest(requestPath = "/") {
  return { locale: "", path: requestPath };
}

/** Same shape as `fakeRequest`, plus the matched route `params` a `:locale` handler reads. */
function fakeRequestWithParams(params: Record<string, string>, requestPath = "/") {
  return { locale: "", path: requestPath, params };
}

/**
 * Stubs `createPageRouteHandler` with a per-page-file tracking mock, keyed by
 * `options.pageFile` — distinct from `stubPageRouteHandler()` above because
 * card C's specs need to tell "the page's own handler ran" apart from "the
 * application's 404 page ran", which a single shared no-op cannot do.
 */
function stubTrackingPageRouteHandler(): Map<string, PageRouteHandler> {
  const handlersByPageFile = new Map<string, PageRouteHandler>();

  vi.spyOn(createPageRouteHandlerModule, "createPageRouteHandler").mockImplementation(
    (options: PageRouteHandlerOptions): PageRouteHandler => {
      const handler = vi.fn(async () => undefined);
      handlersByPageFile.set(options.pageFile, handler);

      return handler;
    },
  );

  return handlersByPageFile;
}

describe("installPageRoutes — locale routing, prefix-except-default", () => {
  async function setUp() {
    config.set("web", { localeRouting: { strategy: "prefix-except-default" } });
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });
    stubPageRouteHandler();

    const appRoot = makeAppTree({ "src/web/posts.page.tsx": "" });
    const appSrcRoot = path.join(appRoot, "src");
    const postsFile = path.join(appSrcRoot, "web", "posts.page.tsx");
    const vite = fakeVite({ [postsFile]: pageModule({ route: "/posts" }) });

    const { run, registered } = install(appSrcRoot, vite);
    await run();

    return { registered };
  }

  it("registers /ar/posts, unnamed, whose handler pins request.locale to ar", async () => {
    const { registered } = await setUp();
    const arRoute = registered.find((route) => route.path === "/ar/posts");

    expect(arRoute).toBeDefined();
    expect(arRoute?.options.name).toBeUndefined();

    const request = fakeRequest();
    await arRoute?.handler({ request, response: fakeResponse() } as unknown as HttpContext);

    expect(request.locale).toBe("ar");
  });

  it("pins /posts to en even with a locale=ar cookie/header already resolved on the request", async () => {
    const { registered } = await setUp();
    const baseRoute = registered.find((route) => route.path === "/posts");

    expect(baseRoute).toBeDefined();
    expect(baseRoute?.options.name).toBeDefined();

    const request = fakeRequest();
    request.locale = "ar";
    await baseRoute?.handler({ request, response: fakeResponse() } as unknown as HttpContext);

    expect(request.locale).toBe("en");
  });

  it("redirects /en/posts to /posts with 301, preserving the query string", async () => {
    const { registered } = await setUp();
    const redirectRoute = registered.find((route) => route.path === "/en/posts");

    expect(redirectRoute).toBeDefined();
    expect(redirectRoute?.options.name).toBeUndefined();

    const response = fakeResponse();
    await redirectRoute?.handler({
      request: fakeRequest("/en/posts?page=2"),
      response,
    } as unknown as HttpContext);

    expect(response.calls.permanentRedirect).toBe("/posts?page=2");
  });

  // Regression: the redirect used to be built from the route PATTERN
  // (`effectivePath`, e.g. `/posts/:slug`), so `/en/posts/hello` redirected
  // to the literal `/posts/:slug`. It must now redirect to the request's own
  // resolved path.
  it("redirects a dynamic route by the request's actual matched path, not the route pattern", async () => {
    config.set("web", { localeRouting: { strategy: "prefix-except-default" } });
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });
    stubPageRouteHandler();

    const appRoot = makeAppTree({ "src/web/posts.page.tsx": "" });
    const appSrcRoot = path.join(appRoot, "src");
    const postsFile = path.join(appSrcRoot, "web", "posts.page.tsx");
    const vite = fakeVite({ [postsFile]: pageModule({ route: "/posts/:slug" }) });

    const { run, registered } = install(appSrcRoot, vite);
    await run();

    const redirectRoute = registered.find((route) => route.path === "/en/posts/:slug");
    expect(redirectRoute).toBeDefined();

    const response = fakeResponse();
    await redirectRoute?.handler({
      request: fakeRequest("/en/posts/hello?a=1&a=2"),
      response,
    } as unknown as HttpContext);

    expect(response.calls.permanentRedirect).toBe("/posts/hello?a=1&a=2");
  });

  it("redirects the root /en to / (not /<pattern>)", async () => {
    config.set("web", { localeRouting: { strategy: "prefix-except-default" } });
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });
    stubPageRouteHandler();

    const appRoot = makeAppTree({ "src/web/home.page.tsx": "" });
    const appSrcRoot = path.join(appRoot, "src");
    const homeFile = path.join(appSrcRoot, "web", "home.page.tsx");
    const vite = fakeVite({ [homeFile]: pageModule({ route: "/" }) });

    const { run, registered } = install(appSrcRoot, vite);
    await run();

    const redirectRoute = registered.find((route) => route.path === "/en");
    expect(redirectRoute).toBeDefined();

    const response = fakeResponse();
    await redirectRoute?.handler({
      request: fakeRequest("/en"),
      response,
    } as unknown as HttpContext);

    expect(response.calls.permanentRedirect).toBe("/");
  });

  it("redirects a terminal wildcard route by its actual matched path", async () => {
    config.set("web", { localeRouting: { strategy: "prefix-except-default" } });
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });
    stubPageRouteHandler();

    const appRoot = makeAppTree({ "src/web/docs.page.tsx": "" });
    const appSrcRoot = path.join(appRoot, "src");
    const docsFile = path.join(appSrcRoot, "web", "docs.page.tsx");
    const vite = fakeVite({ [docsFile]: pageModule({ route: "/docs/*" }) });

    const { run, registered } = install(appSrcRoot, vite);
    await run();

    const redirectRoute = registered.find((route) => route.path === "/en/docs/*");
    expect(redirectRoute).toBeDefined();

    const response = fakeResponse();
    await redirectRoute?.handler({
      request: fakeRequest("/en/docs/a/b"),
      response,
    } as unknown as HttpContext);

    expect(response.calls.permanentRedirect).toBe("/docs/a/b");
  });

  it("never redirects off-origin — a scheme-relative-looking match stays a same-origin path", async () => {
    config.set("web", { localeRouting: { strategy: "prefix-except-default" } });
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });
    stubPageRouteHandler();

    const appRoot = makeAppTree({ "src/web/docs.page.tsx": "" });
    const appSrcRoot = path.join(appRoot, "src");
    const docsFile = path.join(appSrcRoot, "web", "docs.page.tsx");
    const vite = fakeVite({ [docsFile]: pageModule({ route: "/docs/*" }) });

    const { run, registered } = install(appSrcRoot, vite);
    await run();

    const redirectRoute = registered.find((route) => route.path === "/en/docs/*");
    expect(redirectRoute).toBeDefined();

    // The stripped path stays inside `/docs` and is safe by construction; the
    // guard is what protects a stripped/prefixed segment that would otherwise
    // START the Location with `//` — proven directly against the empty case.
    const response = fakeResponse();
    await redirectRoute?.handler({
      request: fakeRequest("/en/docs//evil.com"),
      response,
    } as unknown as HttpContext);

    expect(response.calls.permanentRedirect).toBe("/docs//evil.com");
    expect(response.calls.permanentRedirect?.startsWith("//")).toBe(false);

    const openRedirectResponse = fakeResponse();
    await redirectRoute?.handler({
      request: fakeRequest("/en//evil.com"),
      response: openRedirectResponse,
    } as unknown as HttpContext);

    expect(openRedirectResponse.calls.permanentRedirect).toBe("/evil.com");
    expect(openRedirectResponse.calls.permanentRedirect?.startsWith("//")).toBe(false);
  });
});

describe("installPageRoutes — locale routing, prefix", () => {
  it("redirects the bare path to /<resolved locale>/<path> with 302, preserving the query string", async () => {
    config.set("web", { localeRouting: { strategy: "prefix" } });
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });
    stubPageRouteHandler();

    const appRoot = makeAppTree({ "src/web/posts.page.tsx": "" });
    const appSrcRoot = path.join(appRoot, "src");
    const postsFile = path.join(appSrcRoot, "web", "posts.page.tsx");
    const vite = fakeVite({ [postsFile]: pageModule({ route: "/posts" }) });

    const { run, registered } = install(appSrcRoot, vite);
    await run();

    const baseRoute = registered.find((route) => route.path === "/posts");
    expect(baseRoute).toBeDefined();
    expect(baseRoute?.options.name).toBeDefined();

    const response = fakeResponse();
    const request = fakeRequest("/posts?q=1");
    request.locale = "ar";
    await baseRoute?.handler({ request, response } as unknown as HttpContext);

    expect(response.calls.redirect).toEqual(["/ar/posts?q=1", 302]);
  });

  it("redirects a nested path to /<resolved locale>/<path>", async () => {
    config.set("web", { localeRouting: { strategy: "prefix" } });
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });
    stubPageRouteHandler();

    const appRoot = makeAppTree({ "src/web/posts/slug.page.tsx": "" });
    const appSrcRoot = path.join(appRoot, "src");
    const postFile = path.join(appSrcRoot, "web", "posts", "slug.page.tsx");
    const vite = fakeVite({ [postFile]: pageModule({ route: "/posts/:slug" }) });

    const { run, registered } = install(appSrcRoot, vite);
    await run();

    const baseRoute = registered.find((route) => route.path === "/posts/:slug");
    expect(baseRoute).toBeDefined();

    const response = fakeResponse();
    const request = fakeRequest("/posts/hello");
    request.locale = "ar";
    await baseRoute?.handler({ request, response } as unknown as HttpContext);

    expect(response.calls.redirect).toEqual(["/ar/posts/hello", 302]);
  });
});

describe("installPageRoutes — locale routing, none (the innocent case)", () => {
  it("registers exactly the base path, unchanged from HEAD", async () => {
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });
    stubPageRouteHandler();

    const appRoot = makeAppTree({ "src/web/posts.page.tsx": "" });
    const appSrcRoot = path.join(appRoot, "src");
    const postsFile = path.join(appSrcRoot, "web", "posts.page.tsx");
    const vite = fakeVite({ [postsFile]: pageModule({ route: "/posts" }) });

    const { run, registered } = install(appSrcRoot, vite);
    await run();

    expect(registered.map((route) => route.path)).toEqual(["/posts"]);
    expect(registered[0]?.options.name).toBeDefined();
  });
});

describe("installPageRoutes — locale routing, [locale] folder (card C)", () => {
  it("registers /:locale/posts whose handler pins request.locale to ar for a configured code", async () => {
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });

    const appRoot = makeAppTree({ "src/web/[locale]/posts.page.tsx": "" });
    const appSrcRoot = path.join(appRoot, "src");
    const postsFile = path.join(appSrcRoot, "web", "[locale]", "posts.page.tsx");
    const vite = fakeVite({ [postsFile]: pageModule() });
    const handlersByPageFile = stubTrackingPageRouteHandler();

    const { run, registered } = install(appSrcRoot, vite);
    await run();

    const route = registered.find((entry) => entry.path === "/:locale/posts");
    expect(route).toBeDefined();

    const postsHandler = handlersByPageFile.get(postsFile);
    expect(postsHandler).toBeDefined();

    const request = fakeRequestWithParams({ locale: "ar" });
    await route?.handler({ request, response: fakeResponse() } as unknown as HttpContext);

    expect(request.locale).toBe("ar");
    expect(postsHandler).toHaveBeenCalledTimes(1);
  });

  it("renders the app's own 404 for an unconfigured locale value, never calling the page handler", async () => {
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });

    const appRoot = makeAppTree({
      "src/web/[locale]/posts.page.tsx": "",
      "src/web/404.page.tsx": "",
    });
    const appSrcRoot = path.join(appRoot, "src");
    const postsFile = path.join(appSrcRoot, "web", "[locale]", "posts.page.tsx");
    const notFoundFile = path.join(appSrcRoot, "web", "404.page.tsx");
    const vite = fakeVite({ [postsFile]: pageModule(), [notFoundFile]: pageModule() });
    const handlersByPageFile = stubTrackingPageRouteHandler();

    const { run, registered } = install(appSrcRoot, vite);
    await run();

    const route = registered.find((entry) => entry.path === "/:locale/posts");
    expect(route).toBeDefined();

    const postsHandler = handlersByPageFile.get(postsFile);
    const notFoundHandler = handlersByPageFile.get(notFoundFile);
    expect(postsHandler).toBeDefined();
    expect(notFoundHandler).toBeDefined();

    const context = { request: fakeRequestWithParams({ locale: "fr" }), response: fakeResponse() };
    await route?.handler(context as unknown as HttpContext);

    expect(notFoundHandler).toHaveBeenCalledTimes(1);
    expect(notFoundHandler).toHaveBeenCalledWith(context);
    expect(postsHandler).not.toHaveBeenCalled();
  });

  it("leaves a deeper :locale param untouched — an ordinary param, not locale-routed", async () => {
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });

    const appRoot = makeAppTree({ "src/web/posts/[locale].page.tsx": "" });
    const appSrcRoot = path.join(appRoot, "src");
    const pageFile = path.join(appSrcRoot, "web", "posts", "[locale].page.tsx");
    const vite = fakeVite({ [pageFile]: pageModule() });
    const handlersByPageFile = stubTrackingPageRouteHandler();

    const { run, registered } = install(appSrcRoot, vite);
    await run();

    const route = registered.find((entry) => entry.path === "/posts/:locale");
    expect(route).toBeDefined();

    const pageHandler = handlersByPageFile.get(pageFile);
    expect(pageHandler).toBeDefined();
    // The registered handler is the page's own handler, unwrapped — no
    // locale-code validation runs against a deeper `:locale` param.
    expect(route?.handler).toBe(pageHandler);

    const request = fakeRequestWithParams({ locale: "zz" });
    await route?.handler({ request, response: fakeResponse() } as unknown as HttpContext);

    expect(pageHandler).toHaveBeenCalledTimes(1);
    expect(request.locale).toBe("");
  });

  it("refuses to boot when a config strategy is active alongside a [locale] page, naming the file", async () => {
    config.set("web", { localeRouting: { strategy: "prefix-except-default" } });
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });
    stubPageRouteHandler();

    const appRoot = makeAppTree({ "src/web/[locale]/posts.page.tsx": "" });
    const appSrcRoot = path.join(appRoot, "src");
    const postsFile = path.join(appSrcRoot, "web", "[locale]", "posts.page.tsx");
    const vite = fakeVite({ [postsFile]: pageModule() });

    const { run } = install(appSrcRoot, vite);

    await expect(run()).rejects.toThrow(LocaleParamRoutingConflictError);
    await expect(run()).rejects.toThrow(postsFile);
  });
});
