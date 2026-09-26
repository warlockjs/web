import { isIP } from "node:net";
import type { Request } from "@warlock.js/core";
import type { HostResolver, SitesConfig } from "../sites/site-config.types";
import { createSiteSelector } from "../sites/site-selector";
import { normalizeHost } from "../sites/validate-sites-config";

export type TlsAskHandlerOptions = {
  sites: SitesConfig;
  resolveHost?: HostResolver;
  resolveCache?: { ttl: number };
};

type TlsAskInput = { domain: string | undefined; request: Request };
type TlsAskResult = { status: 200 | 400 | 404 };

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function validDomain(domain: string | undefined): domain is string {
  if (!domain || domain.trim() !== domain || domain.includes("://") || domain.includes("/")) {
    return false;
  }

  const host = normalizeHost(domain);
  return HOSTNAME.test(host) && isIP(host) === 0;
}

/**
 * Answers Caddy's on-demand TLS ask request without registering an HTTP route.
 * A domain is allowed only when it has a fixed host entry or a resolver claim.
 */
export function createTlsAskHandler({ sites, resolveHost, resolveCache }: TlsAskHandlerOptions) {
  const selector = createSiteSelector({ sites, resolveHost, resolveCache });

  return async ({ domain, request }: TlsAskInput): Promise<TlsAskResult> => {
    if (!validDomain(domain)) return { status: 400 };

    const host = normalizeHost(domain);
    const fixedHost = Object.values(sites).some(
      site => "hosts" in site && site.hosts.includes(host),
    );

    if (fixedHost) return { status: 200 };

    const selection = await selector.select({ rawHost: domain, path: "/", request });

    return { status: selection.kind === "site" ? 200 : 404 };
  };
}
