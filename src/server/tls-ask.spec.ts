import { describe, expect, it, vi } from "vitest";
import type { SitesConfig } from "../sites/site-config.types";
import { createTlsAskHandler } from "./tls-ask";

const request = new Request("https://localhost/.well-known/warlock/domain") as never;
const fixed: SitesConfig = {
  landing: { pages: "(landing)", hosts: ["estates.app"] },
  tenant: { pages: "(tenant)", dynamic: true },
};

describe("createTlsAskHandler", () => {
  it("allows a listed host, including uppercase with a port", async () => {
    const ask = createTlsAskHandler({ sites: fixed });
    await expect(ask({ domain: "ESTATES.APP:443", request })).resolves.toEqual({ status: 200 });
  });

  it("allows a host claimed by the resolver", async () => {
    const resolveHost = vi.fn(() => ({ site: "tenant", key: "acme" }));
    const ask = createTlsAskHandler({ sites: fixed, resolveHost });
    await expect(ask({ domain: "acme.com", request })).resolves.toEqual({ status: 200 });
    expect(resolveHost).toHaveBeenCalledWith({ host: "acme.com", request });
  });

  it("denies an unclaimed host", async () => {
    const ask = createTlsAskHandler({ sites: fixed, resolveHost: () => null });
    await expect(ask({ domain: "missing.com", request })).resolves.toEqual({ status: 404 });
  });

  it("does not authorize an unknownHost fallback", async () => {
    const ask = createTlsAskHandler({ sites: fixed, resolveHost: () => null });
    await expect(ask({ domain: "missing.com", request })).resolves.toEqual({ status: 404 });
  });

  it.each([undefined, "", "https://acme.com", "acme.com/path", "acme .com"]) (
    "rejects an absent or invalid domain %#",
    async domain => {
      const ask = createTlsAskHandler({ sites: fixed });
      await expect(ask({ domain, request })).resolves.toEqual({ status: 400 });
    },
  );

  it("rejects an IP literal", async () => {
    const ask = createTlsAskHandler({ sites: fixed });
    await expect(ask({ domain: "127.0.0.1", request })).resolves.toEqual({ status: 400 });
  });

  it("propagates resolver failures", async () => {
    const ask = createTlsAskHandler({
      sites: fixed,
      resolveHost: async () => {
        throw new Error("database unavailable");
      },
    });
    await expect(ask({ domain: "acme.com", request })).rejects.toThrow("database unavailable");
  });
});
