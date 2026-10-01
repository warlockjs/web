import config from "@mongez/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Response, type HttpContext, type Router } from "@warlock.js/core";
import { registerSitemapRoutes } from "./register-sitemap-routes";
import type { SitemapPageSource } from "./sitemap-page-source";

/**
 * The per-site (multi-site) sitemap is built in memory and sent through the
 * route handler. It must go out as `application/xml` exactly like the
 * manifest-backed single-site path; `response.text()` would overwrite the header
 * with `text/plain`. A REAL core `Response` is used so the assertion sees the
 * header the framework would actually put on the wire.
 */

function capturingRouter() {
  const routes = new Map<string, (context: HttpContext) => unknown>();
  const router = {
    get: vi.fn((routePath: string, handler: (context: HttpContext) => unknown) => {
      routes.set(routePath, handler);
    }),
    head: vi.fn(),
  } as unknown as Router;

  return { router, routes };
}

function realResponse() {
  const headers: Record<string, string> = {};
  let sentBody: unknown;
  const response = new Response();

  response.setResponse({
    header: (name: string, value: string) => {
      headers[name] = value;
    },
    getHeader: (name: string) => headers[name],
    status: () => response.baseResponse,
    send: (body: unknown) => {
      sentBody = body;
    },
    sent: false,
    raw: { once: () => {} },
  } as never);

  return { response, headers, getBody: () => sentBody };
}

function requestFor(host: string) {
  return {
    protocol: "https",
    path: "/sitemap.xml",
    method: "GET",
    params: {},
    header: (name: string) => (name === "host" ? host : null),
    baseRequest: { hostname: host },
  };
}

const pageSource: SitemapPageSource = () => [
  { routeName: "home", routePath: "/", site: "landing" },
  { routeName: "about", routePath: "/about", site: "landing" },
];

afterEach(() => {
  config.set("app", {});
  config.set("web", {});
});

describe("registerSitemapRoutes - per-site sitemap", () => {
  it("serves the per-site sitemap as application/xml, not text/plain", async () => {
    config.set("app", { publicUrl: "https://landing.test" });
    config.set("web", {
      sites: { landing: { hosts: ["landing.test"] } },
      sitemap: { enabled: true, path: "/sitemap.xml" },
    });
    const { router, routes } = capturingRouter();
    registerSitemapRoutes(router, {
      path: "/sitemap.xml",
      warn: () => undefined,
      getServingState: () => undefined,
      pageSource,
    });
    const { response, headers, getBody } = realResponse();

    await routes.get("/sitemap.xml")!({
      request: requestFor("landing.test"),
      response,
    } as unknown as HttpContext);

    expect(headers["Content-Type"]).toBe("application/xml");
    expect(String(getBody())).toContain("<urlset");
    expect(String(getBody())).toContain("https://landing.test/about");
  });
});
