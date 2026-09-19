import config from "@mongez/config";
import { afterEach, describe, expect, it } from "vitest";
import type { HttpContext } from "@warlock.js/core";
import {
  installPageRoutesFromManifest,
  type InstallPageRoutesFromManifestOptions,
} from "./install-page-routes-from-manifest";
import type { PageRouteHandler, PageRouteHandlerOptions } from "./create-page-route-handler";
import type { PageManifest, PageManifestPageEntry } from "./page-manifest";
import { NOT_FOUND_ROUTE_PATH } from "./not-found-page";

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

const appModule = { default: () => null };

function manifestOf(pages: PageManifestPageEntry[]): PageManifest {
  return { app: { module: appModule, sourceFile: "src/web/root.tsx" }, pages };
}

const postsPage: PageManifestPageEntry = {
  module: { default: () => null, route: "/posts" },
  sourceFile: "src/app/main/web/posts.page.tsx",
  layouts: [],
};

const postSlugPage: PageManifestPageEntry = {
  module: { default: () => null, route: "/posts/:slug" },
  sourceFile: "src/app/main/web/posts.slug.page.tsx",
  layouts: [],
};

const homePage: PageManifestPageEntry = {
  module: { default: () => null, route: "/" },
  sourceFile: "src/app/main/web/home.page.tsx",
  layouts: [],
};

const docsPage: PageManifestPageEntry = {
  module: { default: () => null, route: "/docs/*" },
  sourceFile: "src/app/main/web/docs.page.tsx",
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
