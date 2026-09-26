import { describe, expect, it } from "vitest";
import type { HostResolver, SitesConfig } from "./site-config.types";
import { assertResolvedSite, normalizeHost, validateSitesConfig } from "./validate-sites-config";

const resolveHost: HostResolver = () => null;

const codes = (sites: SitesConfig, resolver?: HostResolver, unknownHost?: string) =>
  validateSitesConfig({ sites, resolveHost: resolver, unknownHost }).map(error => error.code);

const realEstate: SitesConfig = {
  landing: { pages: "(landing)", hosts: ["estates.app", "www.estates.app"] },
  platform: { pages: "(platform)", hosts: ["app.estates.app"] },
  tenant: { pages: "(tenant)", dynamic: true },
  tenantAdmin: { pages: "(tenant-admin)", dynamic: true, basePath: "/admin" },
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
      sites: { Bad_Key: { pages: "(a)", hosts: ["a.com"] } },
    });
    expect(errors.map(e => e.code)).toEqual(["SITE_KEY_INVALID"]);
    expect(errors[0].message).toContain("Bad_Key");
  });

  it("SITE_PAGES_INVALID", () => {
    expect(codes({ a: { pages: "landing", hosts: ["a.com"] } })).toEqual(["SITE_PAGES_INVALID"]);
    expect(codes({ a: { pages: "(a)/(b)", hosts: ["a.com"] } })).toEqual(["SITE_PAGES_INVALID"]);
  });

  it("SITE_PAGES_SHARED", () => {
    expect(
      codes({
        a: { pages: "(x)", hosts: ["a.com"] },
        b: { pages: "(x)", hosts: ["b.com"] },
      }),
    ).toEqual(["SITE_PAGES_SHARED"]);
  });

  it("SITE_HOSTS_AND_DYNAMIC", () => {
    const site = { pages: "(a)", hosts: ["a.com"], dynamic: true } as unknown as SitesConfig[string];
    expect(codes({ a: site }, resolveHost)).toEqual(["SITE_HOSTS_AND_DYNAMIC"]);
  });

  it("SITE_NO_HOSTS_OR_DYNAMIC", () => {
    const site = { pages: "(a)" } as unknown as SitesConfig[string];
    expect(codes({ a: site })).toEqual(["SITE_NO_HOSTS_OR_DYNAMIC"]);
  });

  it("SITE_HOST_INVALID", () => {
    for (const host of ["Acme.com", "https://acme.com", "acme.com:8080", "acme.com/x", "*.acme.com"]) {
      expect(codes({ a: { pages: "(a)", hosts: [host] } })).toEqual(["SITE_HOST_INVALID"]);
    }
  });

  it("SITE_HOST_OVERLAP only for the same host and basePath", () => {
    expect(
      codes({
        a: { pages: "(a)", hosts: ["x.com"] },
        b: { pages: "(b)", hosts: ["x.com"] },
      }),
    ).toEqual(["SITE_HOST_OVERLAP"]);

    expect(
      codes({
        a: { pages: "(a)", hosts: ["x.com"] },
        b: { pages: "(b)", hosts: ["x.com"], basePath: "/admin" },
      }),
    ).toEqual([]);
  });

  it("SITE_BASEPATH_INVALID", () => {
    for (const basePath of ["admin", "/admin/", "/"]) {
      expect(codes({ a: { pages: "(a)", hosts: ["a.com"], basePath } })).toEqual([
        "SITE_BASEPATH_INVALID",
      ]);
    }
  });

  it("DYNAMIC_SITE_WITHOUT_RESOLVER", () => {
    expect(codes({ t: { pages: "(t)", dynamic: true } })).toEqual([
      "DYNAMIC_SITE_WITHOUT_RESOLVER",
    ]);
  });

  it("RESOLVER_WITHOUT_DYNAMIC_SITE", () => {
    expect(codes({ a: { pages: "(a)", hosts: ["a.com"] } }, resolveHost)).toEqual([
      "RESOLVER_WITHOUT_DYNAMIC_SITE",
    ]);
  });

  it("UNKNOWN_HOST_SITE_MISSING", () => {
    const sites: SitesConfig = { a: { pages: "(a)", hosts: ["a.com"] } };
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
