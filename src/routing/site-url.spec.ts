import { afterEach, describe, expect, it } from "vitest";
import {
  MissingDynamicSiteHostError,
  href,
  registerSiteRoutes,
  resetRouteTable,
} from "./route-table";
import { connectCurrentSite, siteUrl } from "./site-url";

afterEach(() => {
  connectCurrentSite(undefined);
  resetRouteTable();
});

describe("site-aware href", () => {
  it("keeps a same-site link path-only and sends fixed-site links to that host with the dev port", () => {
    connectCurrentSite(() => ({ key: "landing", host: "landing.localhost", basePath: "", protocol: "http:", port: "2030" }));
    registerSiteRoutes("landing", [{ name: "landing.home", path: "/" }], {
      landing: { hosts: ["landing.localhost"] },
      platform: { hosts: ["app.localhost"] },
      tenant: { dynamic: true },
    });
    registerSiteRoutes("platform", [{ name: "platform.home", path: "/dashboard" }], {
      landing: { hosts: ["landing.localhost"] },
      platform: { hosts: ["app.localhost"] },
      tenant: { dynamic: true },
    });
    registerSiteRoutes("tenant", [{ name: "tenant.home", path: "/" }], {
      landing: { hosts: ["landing.localhost"] },
      platform: { hosts: ["app.localhost"] },
      tenant: { dynamic: true },
    });

    expect(href("landing.home")).toBe("/");
    expect(href("platform.home")).toBe("http://app.localhost:2030/dashboard");
    expect(() => href("tenant.home")).toThrow(MissingDynamicSiteHostError);
    expect(href("tenant.home", { $host: "acme.localhost" })).toBe("http://acme.localhost:2030/");
  });

  it("reads siteUrl from the request origin and mount", () => {
    connectCurrentSite(() => ({ key: "admin", host: "acme.localhost", basePath: "/admin", protocol: "http:", port: "2030" }));
    expect(siteUrl()).toBe("http://acme.localhost:2030/admin");
  });
});
