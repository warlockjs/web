import { describe, expect, it, vi } from "vitest";
import type { HostResolution, SitesConfig } from "./site-config.types";
import { createSiteSelector, validateSitesAtBoot } from "./site-selector";

const request = {} as never;
const at = (rawHost: string, path = "/") => ({ rawHost, path, request });

const fixed: SitesConfig = {
  landing: { pages: "(landing)", hosts: ["estates.app", "www.estates.app"] },
  platform: { pages: "(platform)", hosts: ["app.estates.app"] },
};

describe("createSiteSelector", () => {
  it("selects by exact host", async () => {
    const { select } = createSiteSelector({ sites: fixed });
    expect(await select(at("app.estates.app"))).toEqual({
      kind: "site",
      site: "platform",
      host: "app.estates.app",
      basePath: "",
    });
  });

  it("matches a listed www alias but not an unlisted one", async () => {
    const { select } = createSiteSelector({ sites: fixed });
    expect((await select(at("www.estates.app"))).kind).toBe("site");
    expect(await select(at("www.app.estates.app"))).toEqual({
      kind: "not-found",
      host: "www.app.estates.app",
    });
  });

  it("normalises uppercase and port", async () => {
    const { select } = createSiteSelector({ sites: fixed });
    expect(await select(at("APP.Estates.App:443"))).toMatchObject({
      site: "platform",
      host: "app.estates.app",
    });
  });

  it("picks the longest basePath on segment boundaries", async () => {
    const sites: SitesConfig = {
      main: { pages: "(main)", hosts: ["acme.com"] },
      admin: { pages: "(admin)", hosts: ["acme.com"], basePath: "/admin" },
      deep: { pages: "(deep)", hosts: ["acme.com"], basePath: "/admin/deep" },
    };
    const { select } = createSiteSelector({ sites });
    const site = async (p: string) => ((await select(at("acme.com", p))) as { site: string }).site;
    expect(await site("/admin")).toBe("admin");
    expect(await site("/admin/x")).toBe("admin");
    expect(await site("/admin/deep/y")).toBe("deep");
    expect(await site("/administrator")).toBe("main");
    expect(await select(at("acme.com", "/admin/deep"))).toMatchObject({ basePath: "/admin/deep" });
  });

  it("calls the resolver only for unlisted hosts", async () => {
    const resolveHost = vi.fn(() => null);
    const sites: SitesConfig = { ...fixed, tenant: { pages: "(tenant)", dynamic: true } };
    const { select } = createSiteSelector({ sites, resolveHost });
    await select(at("estates.app"));
    expect(resolveHost).not.toHaveBeenCalled();
    await select(at("other.com"));
    expect(resolveHost).toHaveBeenCalledWith({ host: "other.com", request });
  });

  it("never calls the resolver for a listed host with a basePath mismatch", async () => {
    const resolveHost = vi.fn(() => null);
    const sites: SitesConfig = {
      admin: { pages: "(admin)", hosts: ["acme.com"], basePath: "/admin" },
      tenant: { pages: "(tenant)", dynamic: true },
    };
    const { select } = createSiteSelector({ sites, resolveHost });
    expect(await select(at("acme.com", "/"))).toEqual({ kind: "not-found", host: "acme.com" });
    expect(resolveHost).not.toHaveBeenCalled();
  });

  describe("resolver", () => {
    const sites: SitesConfig = {
      ...fixed,
      tenant: { pages: "(tenant)", dynamic: true },
      portal: { pages: "(portal)", dynamic: true, basePath: "/portal" },
    };
    const hit: HostResolution = { site: "tenant", key: "t1" };

    it("null goes to not-found", async () => {
      const { select } = createSiteSelector({ sites, resolveHost: () => null });
      expect(await select(at("x.com"))).toEqual({ kind: "not-found", host: "x.com" });
    });

    it("null goes to unknownHost site", async () => {
      const { select } = createSiteSelector({ sites, resolveHost: () => null, unknownHost: "landing" });
      expect(await select(at("x.com"))).toMatchObject({ kind: "site", site: "landing", host: "x.com" });
    });

    it("unknownHost not-found stays not-found", async () => {
      const { select } = createSiteSelector({ sites, resolveHost: () => null, unknownHost: "not-found" });
      expect((await select(at("x.com"))).kind).toBe("not-found");
    });

    it("rejects when the resolver throws", async () => {
      const { select } = createSiteSelector({
        sites,
        resolveHost: async () => {
          throw new Error("db down");
        },
        unknownHost: "landing",
      });
      await expect(select(at("x.com"))).rejects.toThrow("db down");
    });

    it("throws for an invalid resolved site", async () => {
      const { select } = createSiteSelector({ sites, resolveHost: () => ({ site: "landing", key: "k" }) });
      await expect(select(at("x.com"))).rejects.toThrow(/not a dynamic site/);
    });

    it("honours a resolved site's basePath", async () => {
      const resolution: HostResolution = { site: "portal", key: "p" };
      const { select } = createSiteSelector({ sites, resolveHost: () => resolution });
      expect(await select(at("x.com", "/portal/a"))).toEqual({
        kind: "site",
        site: "portal",
        host: "x.com",
        basePath: "/portal",
        resolution,
      });
      expect((await select(at("x.com", "/portalx"))).kind).toBe("not-found");
      expect((await select(at("x.com", "/"))).kind).toBe("not-found");
    });

    describe("cache", () => {
      const setup = (fn: () => HostResolution | null | Promise<HostResolution | null>) => {
        let now = 0;
        const resolveHost = vi.fn(fn);
        const selector = createSiteSelector({
          sites,
          resolveHost,
          resolveCache: { ttl: 10 },
          now: () => now,
        });
        return { resolveHost, selector, advance: (ms: number) => (now += ms) };
      };

      it("hits within ttl and expires after", async () => {
        const { resolveHost, selector, advance } = setup(() => hit);
        await selector.select(at("x.com"));
        advance(9_999);
        await selector.select(at("x.com", "/other"));
        expect(resolveHost).toHaveBeenCalledTimes(1);
        advance(1);
        await selector.select(at("x.com"));
        expect(resolveHost).toHaveBeenCalledTimes(2);
      });

      it("caches null", async () => {
        const { resolveHost, selector } = setup(() => null);
        await selector.select(at("x.com"));
        await selector.select(at("x.com"));
        expect(resolveHost).toHaveBeenCalledTimes(1);
      });

      it("forget drops the entry", async () => {
        const { resolveHost, selector } = setup(() => hit);
        await selector.select(at("x.com"));
        selector.forget("X.com:80");
        await selector.select(at("x.com"));
        expect(resolveHost).toHaveBeenCalledTimes(2);
      });

      it("does not cache errors", async () => {
        let fail = true;
        const { resolveHost, selector } = setup(() => {
          if (fail) throw new Error("boom");
          return hit;
        });
        await expect(selector.select(at("x.com"))).rejects.toThrow("boom");
        fail = false;
        expect((await selector.select(at("x.com"))).kind).toBe("site");
        expect(resolveHost).toHaveBeenCalledTimes(2);
      });
    });
  });

  it("does not cache without resolveCache", async () => {
    const resolveHost = vi.fn(() => null);
    const sites: SitesConfig = { ...fixed, tenant: { pages: "(tenant)", dynamic: true } };
    const { select } = createSiteSelector({ sites, resolveHost });
    await select(at("x.com"));
    await select(at("x.com"));
    expect(resolveHost).toHaveBeenCalledTimes(2);
  });
});

describe("Real-Estate config", () => {
  const sites: SitesConfig = {
    landing: { pages: "(landing)", hosts: ["estates.app", "www.estates.app"] },
    platform: { pages: "(platform)", hosts: ["app.estates.app"] },
    tenant: { pages: "(tenant)", dynamic: true },
    tenantAdmin: { pages: "(tenant-admin)", dynamic: true },
  };
  const resolveHost = ({ host }: { host: string }): HostResolution | null => {
    if (host === "acme.com") return { site: "tenant", key: "acme" };
    if (host === "admin.acme.com") return { site: "tenantAdmin", key: "acme" };
    return null;
  };
  const { select } = createSiteSelector({ sites, resolveHost });

  it.each([
    ["estates.app", "landing"],
    ["app.estates.app", "platform"],
    ["acme.com", "tenant"],
    ["admin.acme.com", "tenantAdmin"],
  ])("%s -> %s", async (host, site) => {
    expect(await select(at(host))).toMatchObject({ kind: "site", site });
  });

  it("evil.com -> not-found", async () => {
    expect(await select(at("evil.com"))).toEqual({ kind: "not-found", host: "evil.com" });
  });
});

describe("validateSitesAtBoot", () => {
  it("passes a valid config", () => {
    expect(() => validateSitesAtBoot({ sites: fixed })).not.toThrow();
  });

  it("throws one error listing every problem, including resolver codes", () => {
    const sites: SitesConfig = {
      a: { pages: "(a)", dynamic: true },
      b: { pages: "bad", hosts: ["b.com"] },
    };
    expect(() => validateSitesAtBoot({ sites })).toThrow(/SITE_PAGES_INVALID[\s\S]*DYNAMIC_SITE_WITHOUT_RESOLVER/);
    expect(() => validateSitesAtBoot({ sites: fixed, resolveHost: () => null })).toThrow(
      /RESOLVER_WITHOUT_DYNAMIC_SITE/,
    );
  });
});
