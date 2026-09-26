import type { Request } from "@warlock.js/core";
import type { HostResolution, HostResolver, SitesConfig } from "./site-config.types";
import { assertResolvedSite, normalizeHost, validateSitesConfig } from "./validate-sites-config";

export type SiteSelectionInput = {
  rawHost: string;
  path: string;
  request: Request;
};

export type SiteSelection =
  | { kind: "site"; site: string; host: string; basePath: string; resolution?: HostResolution }
  | { kind: "not-found"; host: string };

export type SiteSelectorOptions = {
  sites: SitesConfig;
  resolveHost?: HostResolver;
  /** Memoises resolver results (including `null`) by host for `ttl` seconds. */
  resolveCache?: { ttl: number };
  unknownHost?: "not-found" | string;
  /** Clock in milliseconds; injectable for tests. */
  now?: () => number;
};

type CacheEntry = { value: HostResolution | null; expiresAt: number };

/** True when `basePath` prefixes `path` on a segment boundary; an empty basePath matches all. */
function prefixes(basePath: string, path: string): boolean {
  return basePath === "" || path === basePath || path.startsWith(`${basePath}/`);
}

/** Pure host → site selection; does no routing and touches no server. */
export function createSiteSelector({
  sites,
  resolveHost,
  resolveCache,
  unknownHost,
  now = Date.now,
}: SiteSelectorOptions) {
  const cache = new Map<string, CacheEntry>();

  const resolve = async (host: string, request: Request): Promise<HostResolution | null> => {
    if (!resolveHost) return null;

    if (resolveCache) {
      const entry = cache.get(host);

      if (entry && entry.expiresAt > now()) return entry.value;

      cache.delete(host);
    }

    // A throw propagates and is never cached.
    const value = await resolveHost({ host, request });

    if (resolveCache) {
      cache.set(host, { value, expiresAt: now() + resolveCache.ttl * 1000 });
    }

    return value;
  };

  const fallback = (host: string): SiteSelection => {
    if (unknownHost && unknownHost !== "not-found" && unknownHost in sites) {
      return {
        kind: "site",
        site: unknownHost,
        host,
        basePath: sites[unknownHost].basePath ?? "",
      };
    }

    return { kind: "not-found", host };
  };

  const select = async ({ rawHost, path, request }: SiteSelectionInput): Promise<SiteSelection> => {
    const host = normalizeHost(rawHost);

    let listed = false;
    let best: { site: string; basePath: string } | undefined;

    for (const [key, site] of Object.entries(sites)) {
      if (!("hosts" in site) || !site.hosts.includes(host)) continue;

      listed = true;
      const basePath = site.basePath ?? "";

      if (prefixes(basePath, path) && (!best || basePath.length > best.basePath.length)) {
        best = { site: key, basePath };
      }
    }

    if (best) return { kind: "site", host, ...best };

    // Exact host always beats the resolver, even when no basePath matched.
    if (listed || !resolveHost) return fallback(host);

    const resolution = await resolve(host, request);

    if (!resolution) return fallback(host);

    assertResolvedSite(resolution, sites);

    const basePath = sites[resolution.site].basePath ?? "";

    if (!prefixes(basePath, path)) return fallback(host);

    return { kind: "site", site: resolution.site, host, basePath, resolution };
  };

  const forget = (host: string): void => {
    cache.delete(normalizeHost(host));
  };

  return { select, forget };
}

/** Complete boot check, including the resolver codes discovery skips; throws one Error. */
export function validateSitesAtBoot(config: {
  sites: SitesConfig;
  resolveHost?: HostResolver;
  unknownHost?: "not-found" | string;
}): void {
  const errors = validateSitesConfig(config);

  if (errors.length === 0) return;

  throw new Error(
    `Invalid web.sites configuration:\n${errors.map(error => `- [${error.code}] ${error.message}`).join("\n")}`,
  );
}
