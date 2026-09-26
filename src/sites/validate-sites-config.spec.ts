import { describe, expect, it } from "vitest";
import type { HostResolver, SitesConfig } from "./site-config.types";
import { assertResolvedSite, normalizeHost, validateSitesConfig } from "./validate-sites-config";

const resolveHost: HostResolver = () => null;

const codes = (sites: SitesConfig, resolver?: HostResolver, unknownHost?: string) =>
  validateSitesConfig({ sites, resolveHost: resolver, unknownHost }).map(error => error.code);

const realEstate: SitesConfig = {
  landing: { hosts: ["estates.app", "www.estates.app"] },
  platform: { hosts: ["app.estates.app"] },
  tenant: { dynamic: true },
  tenantAdmin: { dynamic: true, basePath: "/admin" },
};

describe("validateSitesConfig", () => {
  it("accepts the Real-Estate config", () => {
    expect(validateSitesConfig({ sites: realEstate, resolveHost })).toEqual([]);
    expect(
      validateSitesConfig({ sites: realEstate, resolveHost, unknownHost: "landing" }),
    ).toEqual([]);
  });

  it("SITE_KEY_INVALID", () => {
    const errors = validateSitesConfig({
      sites: { Bad_Key: { hosts: ["a.com"] } },
    });
    expect(errors.map(e => e.code)).toEqual(["SITE_KEY_INVALID"]);
    expect(errors[0].message).toContain("Bad_Key");
  });

  it("reports that pages was removed", () => {
    const sites = { landing: { pages: "(marketing)", hosts: ["estates.app"] } } as unknown as SitesConfig;

    expect(validateSitesConfig({ sites })).toEqual([
      {
        code: "SITE_PAGES_REMOVED",
        site: "landing",
        message:
          'web.sites.landing.pages was removed in 5.23.1: move src/web/(marketing) to src/web/$sites/landing and delete "pages".',
      },
    ]);
  });

  it("SITE_HOSTS_AND_DYNAMIC", () => {
    const site = { hosts: ["a.com"], dynamic: true } as unknown as SitesConfig[string];
    expect(codes({ a: site }, resolveHost)).toEqual(["SITE_HOSTS_AND_DYNAMIC"]);
  });

  it("SITE_NO_HOSTS_OR_DYNAMIC", () => {
    const site = {} as SitesConfig[string];
    expect(codes({ a: site })).toEqual(["SITE_NO_HOSTS_OR_DYNAMIC"]);
  });

  it("SITE_HOST_INVALID", () => {
    for (const host of ["Acme.com", "https://acme.com", "acme.com:8080", "acme.com/x", "*.acme.com"]) {
      expect(codes({ a: { hosts: [host] } })).toEqual(["SITE_HOST_INVALID"]);
    }
  });

  it("SITE_HOST_OVERLAP only for the same host and basePath", () => {
    expect(
      codes({
        a: { hosts: ["x.com"] },
        b: { hosts: ["x.com"] },
      }),
    ).toEqual(["SITE_HOST_OVERLAP"]);

    expect(
      codes({
        a: { hosts: ["x.com"] },
        b: { hosts: ["x.com"], basePath: "/admin" },
      }),
    ).toEqual([]);
  });

  it("SITE_BASEPATH_INVALID", () => {
    for (const basePath of ["admin", "/admin/", "/"]) {
      expect(codes({ a: { hosts: ["a.com"], basePath } })).toEqual([
        "SITE_BASEPATH_INVALID",
      ]);
    }
  });

  it("DYNAMIC_SITE_WITHOUT_RESOLVER", () => {
    expect(codes({ t: { dynamic: true } })).toEqual([
      "DYNAMIC_SITE_WITHOUT_RESOLVER",
    ]);
  });

  it("RESOLVER_WITHOUT_DYNAMIC_SITE", () => {
    expect(codes({ a: { hosts: ["a.com"] } }, resolveHost)).toEqual([
      "RESOLVER_WITHOUT_DYNAMIC_SITE",
    ]);
  });

  it("UNKNOWN_HOST_SITE_MISSING", () => {
    const sites: SitesConfig = { a: { hosts: ["a.com"] } };
    expect(codes(sites, undefined, "ghost")).toEqual(["UNKNOWN_HOST_SITE_MISSING"]);
  });
});

describe("normalizeHost", () => {
  it("lowercases and strips the port", () => {
    expect(normalizeHost("WWW.Acme.com:443")).toBe("www.acme.com");
  });

  it("strips a trailing dot and keeps www", () => {
    expect(normalizeHost("www.acme.com.")).toBe("www.acme.com");
    expect(normalizeHost("acme.localhost:2030")).toBe("acme.localhost");
  });
});

describe("assertResolvedSite", () => {
  it("accepts a dynamic site", () => {
    expect(() => assertResolvedSite({ site: "tenant", key: "1" }, realEstate)).not.toThrow();
  });

  it("throws for a fixed or unknown site", () => {
    expect(() => assertResolvedSite({ site: "landing", key: "1" }, realEstate)).toThrow(/landing/);
    expect(() => assertResolvedSite({ site: "ghost", key: "1" }, realEstate)).toThrow(/ghost/);
  });
});
