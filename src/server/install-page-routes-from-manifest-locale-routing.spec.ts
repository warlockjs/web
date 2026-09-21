import config from "@mongez/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpContext } from "@warlock.js/core";
import {
  installPageRoutesFromManifest,
  type InstallPageRoutesFromManifestOptions,
} from "./install-page-routes-from-manifest";
import type { PageRouteHandler, PageRouteHandlerOptions } from "./create-page-route-handler";
import type { PageManifest, PageManifestPageEntry } from "./page-manifest";
import { NOT_FOUND_ROUTE_PATH } from "./not-found-page";
import { LocaleParamRoutingConflictError } from "./locale-routing/locale-param-routing-conflict";

/**
 * Card A of `releases/v5.17-locale-routing-design-note.md` — `web.localeRouting`.
 * Proves production's manifest installer registers the same locale routes
 * dev's own installer does (`install-page-routes-locale-routing.spec.ts`), so
 * the two modes cannot disagree about a page's locale-prefixed URLs.
 */

type RegisteredRoute = {
  path: string;
  handler: PageRouteHandler;
  options: { name?: string; isPage?: boolean };
};

function recordingRouter() {
  const registered: RegisteredRoute[] = [];
  const notFound: RegisteredRoute[] = [];

  const router = {
    get(path: string, handler: PageRouteHandler, options: RegisteredRoute["options"]) {
      (path === NOT_FOUND_ROUTE_PATH ? notFound : registered).push({ path, handler, options });
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

const appModule = { config: {}, default: () => null };

function manifestOf(pages: PageManifestPageEntry[]): PageManifest {
  return { app: { module: appModule, sourceFile: "src/web/root.tsx" }, pages };
}

const postsPage: PageManifestPageEntry = {
  module: { config: { route: "/posts" }, default: () => null },
  sourceFile: "src/app/main/web/posts.page.tsx",
  layouts: [],
};

const postSlugPage: PageManifestPageEntry = {
  module: { config: { route: "/posts/:slug" }, default: () => null },
  sourceFile: "src/app/main/web/posts.slug.page.tsx",
  layouts: [],
};

const homePage: PageManifestPageEntry = {
  module: { config: { route: "/" }, default: () => null },
  sourceFile: "src/app/main/web/home.page.tsx",
  layouts: [],
};

const docsPage: PageManifestPageEntry = {
  module: { config: { route: "/docs/*" }, default: () => null },
  sourceFile: "src/app/main/web/docs.page.tsx",
  layouts: [],
};

/** Card C: a `[locale]`-folder page, expressed here as an explicit `route`. */
const localePostsPage: PageManifestPageEntry = {
  module: { config: { route: "/:locale/posts" }, default: () => null },
  sourceFile: "src/app/main/web/[locale]/posts.page.tsx",
  layouts: [],
};

/** A `:locale` param NOT in the first segment — an ordinary param (card C.1). */
const deepLocaleParamPage: PageManifestPageEntry = {
  module: { config: { route: "/posts/:locale" }, default: () => null },
  sourceFile: "src/app/main/web/posts/locale-page.page.tsx",
  layouts: [],
};

const notFoundPage: PageManifestPageEntry = {
  module: { config: {}, default: () => null },
  sourceFile: "src/app/main/web/404.page.tsx",
  layouts: [],
};

/** A minimal `Response` double that records what it was asked to do. */
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

/** A minimal `Request` double: a settable `locale`, and `path` — Fastify's raw `url` (`pathname` + `?search`, verbatim). */
function fakeRequest(requestPath = "/") {
  return { locale: "", path: requestPath };
}

/** Same shape as `fakeRequest`, plus the matched route `params` a `:locale` handler reads. */
function fakeRequestWithParams(params: Record<string, string>, requestPath = "/") {
  return { locale: "", path: requestPath, params };
}

/**
 * A `createHandler` factory that tracks one mock per `options.pageFile` —
 * distinct from `recordingHandlerFactory()` above because card C's specs need
 * to tell "the page's own handler ran" apart from "the application's 404 page
 * ran", which a single shared no-op cannot do.
 */
function trackingHandlerFactory() {
  const handlersByPageFile = new Map<string, PageRouteHandler>();

  const createHandler = (options: PageRouteHandlerOptions): PageRouteHandler => {
    const handler = vi.fn(async () => undefined);
    handlersByPageFile.set(options.pageFile, handler);

    return handler;
  };

  return { createHandler, handlersByPageFile };
}

afterEach(() => {
  config.set("web", {});
  config.set("app", {});
});

describe("installPageRoutesFromManifest — locale routing, prefix-except-default", () => {
  function setUp() {
    config.set("web", { localeRouting: { strategy: "prefix-except-default" } });
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });

    const { router, registered } = recordingRouter();
    const { createHandler } = recordingHandlerFactory();

    installPageRoutesFromManifest({
      router,
      manifest: manifestOf([postsPage]),
      createHandler,
    });

    return { registered };
  }

  it("registers /ar/posts, unnamed, whose handler pins request.locale to ar", async () => {
    const { registered } = setUp();
    const arRoute = registered.find((route) => route.path === "/ar/posts");

    expect(arRoute).toBeDefined();
    expect(arRoute?.options.name).toBeUndefined();

    const request = fakeRequest();
    await arRoute?.handler({ request, response: fakeResponse() } as unknown as HttpContext);

    expect(request.locale).toBe("ar");
  });

  it("pins /posts to en even though a cookie/header would resolve ar — path locale is deterministic", async () => {
    const { registered } = setUp();
    const baseRoute = registered.find((route) => route.path === "/posts");

    expect(baseRoute).toBeDefined();
    expect(baseRoute?.options.name).toBeDefined();

    // A `locale` already seeded on the request stands in for what a cookie or
    // header would otherwise resolve to — the base registration overwrites it
    // unconditionally with the default, per design note §A.3.
    const request = fakeRequest();
    request.locale = "ar";
    await baseRoute?.handler({ request, response: fakeResponse() } as unknown as HttpContext);

    expect(request.locale).toBe("en");
  });

  it("redirects /en/posts (the default's prefix) to /posts with 301, preserving the query string", async () => {
    const { registered } = setUp();
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

    const { router, registered } = recordingRouter();
    const { createHandler } = recordingHandlerFactory();

    installPageRoutesFromManifest({ router, manifest: manifestOf([postSlugPage]), createHandler });

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

    const { router, registered } = recordingRouter();
    const { createHandler } = recordingHandlerFactory();

    installPageRoutesFromManifest({ router, manifest: manifestOf([homePage]), createHandler });

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

    const { router, registered } = recordingRouter();
    const { createHandler } = recordingHandlerFactory();

    installPageRoutesFromManifest({ router, manifest: manifestOf([docsPage]), createHandler });

    const redirectRoute = registered.find((route) => route.path === "/en/docs/*");
    expect(redirectRoute).toBeDefined();

    const response = fakeResponse();
    await redirectRoute?.handler({
      request: fakeRequest("/en/docs/a/b"),
      response,
    } as unknown as HttpContext);

    expect(response.calls.permanentRedirect).toBe("/docs/a/b");
  });

  it("never redirects off-origin — a stripped/prefixed segment stays a same-origin path", async () => {
    config.set("web", { localeRouting: { strategy: "prefix-except-default" } });
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });

    const { router, registered } = recordingRouter();
    const { createHandler } = recordingHandlerFactory();

    installPageRoutesFromManifest({ router, manifest: manifestOf([docsPage]), createHandler });

    const redirectRoute = registered.find((route) => route.path === "/en/docs/*");
    expect(redirectRoute).toBeDefined();

    const response = fakeResponse();
    await redirectRoute?.handler({
      request: fakeRequest("/en/docs//evil.com"),
      response,
    } as unknown as HttpContext);

    expect(response.calls.permanentRedirect).toBe("/docs//evil.com");
    expect(response.calls.permanentRedirect?.startsWith("//")).toBe(false);

    // The case the guard actually exists for: stripping consumes everything
    // up to a double slash, which would otherwise start the Location with
    // `//` — a scheme-relative URL a browser reads as off-origin.
    const openRedirectResponse = fakeResponse();
    await redirectRoute?.handler({
      request: fakeRequest("/en//evil.com"),
      response: openRedirectResponse,
    } as unknown as HttpContext);

    expect(openRedirectResponse.calls.permanentRedirect).toBe("/evil.com");
    expect(openRedirectResponse.calls.permanentRedirect?.startsWith("//")).toBe(false);
  });
});

describe("installPageRoutesFromManifest — locale routing, prefix", () => {
  it("redirects the bare path to /<resolved locale>/<path> with 302, preserving the query string", async () => {
    config.set("web", { localeRouting: { strategy: "prefix" } });
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });

    const { router, registered } = recordingRouter();
    const { createHandler } = recordingHandlerFactory();

    installPageRoutesFromManifest({ router, manifest: manifestOf([postsPage]), createHandler });

    const baseRoute = registered.find((route) => route.path === "/posts");
    expect(baseRoute).toBeDefined();
    expect(baseRoute?.options.name).toBeDefined();

    const response = fakeResponse();
    const request = fakeRequest("/posts?q=1");
    request.locale = "ar";
    await baseRoute?.handler({ request, response } as unknown as HttpContext);

    expect(response.calls.redirect).toEqual(["/ar/posts?q=1", 302]);
  });

  it("redirects a nested path to /<resolved locale>/<path> (root case)", async () => {
    config.set("web", { localeRouting: { strategy: "prefix" } });
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });

    const { router, registered } = recordingRouter();
    const { createHandler } = recordingHandlerFactory();

    installPageRoutesFromManifest({ router, manifest: manifestOf([postSlugPage]), createHandler });

    const baseRoute = registered.find((route) => route.path === "/posts/:slug");
    expect(baseRoute).toBeDefined();

    const response = fakeResponse();
    const request = fakeRequest("/posts/hello");
    request.locale = "ar";
    await baseRoute?.handler({ request, response } as unknown as HttpContext);

    expect(response.calls.redirect).toEqual(["/ar/posts/hello", 302]);
  });
});

describe("installPageRoutesFromManifest — locale routing, none", () => {
  it("registers exactly the base path, unchanged from the no-locale-routing behaviour", () => {
    config.set("web", {});
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });

    const { router, registered } = recordingRouter();
    const { createHandler } = recordingHandlerFactory();

    installPageRoutesFromManifest({ router, manifest: manifestOf([postsPage]), createHandler });

    expect(registered.map((route) => route.path)).toEqual(["/posts"]);
    expect(registered[0]?.options.name).toBeDefined();
  });
});

describe("installPageRoutesFromManifest — locale routing, [locale] folder (card C)", () => {
  it("registers /:locale/posts whose handler pins request.locale to ar for a configured code", async () => {
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });

    const { router, registered } = recordingRouter();
    const { createHandler, handlersByPageFile } = trackingHandlerFactory();

    installPageRoutesFromManifest({
      router,
      manifest: manifestOf([localePostsPage]),
      createHandler,
    });

    const route = registered.find((entry) => entry.path === "/:locale/posts");
    expect(route).toBeDefined();

    const postsHandler = handlersByPageFile.get(localePostsPage.sourceFile);
    expect(postsHandler).toBeDefined();

    const request = fakeRequestWithParams({ locale: "ar" });
    await route?.handler({ request, response: fakeResponse() } as unknown as HttpContext);

    expect(request.locale).toBe("ar");
    expect(postsHandler).toHaveBeenCalledTimes(1);
  });

  it("renders the app's own 404 for an unconfigured locale value, never calling the page handler", async () => {
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });

    const { router, registered } = recordingRouter();
    const { createHandler, handlersByPageFile } = trackingHandlerFactory();

    installPageRoutesFromManifest({
      router,
      manifest: manifestOf([localePostsPage, notFoundPage]),
      createHandler,
    });

    const route = registered.find((entry) => entry.path === "/:locale/posts");
    expect(route).toBeDefined();

    const postsHandler = handlersByPageFile.get(localePostsPage.sourceFile);
    const notFoundHandler = handlersByPageFile.get(notFoundPage.sourceFile);
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

    const { router, registered } = recordingRouter();
    const { createHandler, handlersByPageFile } = trackingHandlerFactory();

    installPageRoutesFromManifest({
      router,
      manifest: manifestOf([deepLocaleParamPage]),
      createHandler,
    });

    const route = registered.find((entry) => entry.path === "/posts/:locale");
    expect(route).toBeDefined();

    const pageHandler = handlersByPageFile.get(deepLocaleParamPage.sourceFile);
    expect(pageHandler).toBeDefined();
    // The registered handler is the page's own handler, unwrapped — no
    // locale-code validation runs against a deeper `:locale` param.
    expect(route?.handler).toBe(pageHandler);

    const request = fakeRequestWithParams({ locale: "zz" });
    await route?.handler({ request, response: fakeResponse() } as unknown as HttpContext);

    expect(pageHandler).toHaveBeenCalledTimes(1);
    expect(request.locale).toBe("");
  });

  it("refuses to boot when a config strategy is active alongside a [locale] page, naming the file", () => {
    config.set("web", { localeRouting: { strategy: "prefix-except-default" } });
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });

    const { router } = recordingRouter();
    const { createHandler } = recordingHandlerFactory();

    expect(() =>
      installPageRoutesFromManifest({
        router,
        manifest: manifestOf([localePostsPage]),
        createHandler,
      }),
    ).toThrow(LocaleParamRoutingConflictError);
    expect(() =>
      installPageRoutesFromManifest({
        router,
        manifest: manifestOf([localePostsPage]),
        createHandler,
      }),
    ).toThrow(localePostsPage.sourceFile);
  });
});
