import type { HostResolution, HostResolver, SitesConfig } from "./site-config.types";

export type SiteConfigErrorCode =
  | "SITE_KEY_INVALID"
  | "SITE_PAGES_INVALID"
  | "SITE_PAGES_SHARED"
  | "SITE_HOSTS_AND_DYNAMIC"
  | "SITE_NO_HOSTS_OR_DYNAMIC"
  | "SITE_HOST_INVALID"
  | "SITE_HOST_OVERLAP"
  | "SITE_BASEPATH_INVALID"
  | "DYNAMIC_SITE_WITHOUT_RESOLVER"
  | "RESOLVER_WITHOUT_DYNAMIC_SITE"
  | "UNKNOWN_HOST_SITE_MISSING";

export type SiteConfigError = {
  code: SiteConfigErrorCode;
  site?: string;
  message: string;
};

const SITE_KEY = /^[a-z][a-zA-Z0-9-]*$/;
const PAGES_GROUP = /^\([a-zA-Z0-9][a-zA-Z0-9_-]*\)$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Site-selection host form: lowercase, port and trailing dot removed.
 * `www.` is kept on purpose; it is an alias only when a site lists it.
 */
export function normalizeHost(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

/** Pure structural validation of `web.sites`; never throws and touches no filesystem. */
export function validateSitesConfig({
  sites,
  resolveHost,
  unknownHost,
}: {
  sites: SitesConfig;
  resolveHost?: HostResolver;
  unknownHost?: "not-found" | string;
}): SiteConfigError[] {
  const errors: SiteConfigError[] = [];
  const pagesOwner = new Map<string, string>();
  const hostOwner = new Map<string, string>();
  const dynamicSites: string[] = [];

  for (const [key, site] of Object.entries(sites)) {
    if (!SITE_KEY.test(key)) {
      errors.push({
        code: "SITE_KEY_INVALID",
        site: key,
        message: `Site key "${key}" is invalid; it must match ${SITE_KEY}.`,
      });
    }

    const pages: unknown = site.pages;
    if (typeof pages !== "string" || !PAGES_GROUP.test(pages)) {
      errors.push({
        code: "SITE_PAGES_INVALID",
        site: key,
        message: `Site "${key}" has invalid pages "${String(pages)}"; it must be a single route-group folder name such as "(landing)".`,
      });
    } else {
      const owner = pagesOwner.get(pages);
      if (owner !== undefined) {
        errors.push({
          code: "SITE_PAGES_SHARED",
          site: key,
          message: `Sites "${owner}" and "${key}" both use pages "${pages}"; each site needs its own folder.`,
        });
      } else {
        pagesOwner.set(pages, key);
      }
    }

    const hosts = (site as { hosts?: unknown }).hosts;
    const hasHosts = hosts !== undefined;
    const hasResolve = (site as { dynamic?: unknown }).dynamic === true;
    if (hasResolve) dynamicSites.push(key);

    if (hasHosts && hasResolve) {
      errors.push({
        code: "SITE_HOSTS_AND_DYNAMIC",
        site: key,
        message: `Site "${key}" sets both hosts and dynamic; use one or the other.`,
      });
    } else if (!hasHosts && !hasResolve) {
      errors.push({
        code: "SITE_NO_HOSTS_OR_DYNAMIC",
        site: key,
        message: `Site "${key}" needs either hosts or dynamic: true.`,
      });
    }

    const basePath = site.basePath;
    if (
      basePath !== undefined &&
      (typeof basePath !== "string" ||
        basePath === "/" ||
        !basePath.startsWith("/") ||
        basePath.endsWith("/"))
    ) {
      errors.push({
        code: "SITE_BASEPATH_INVALID",
        site: key,
        message: `Site "${key}" has invalid basePath "${String(basePath)}"; it must start with "/", must not end with "/", and must not be "/".`,
      });
    }

    if (hasHosts && !hasResolve) {
      const list: unknown[] = Array.isArray(hosts) ? hosts : [];
      const prefix = typeof basePath === "string" ? basePath : "";

      for (const host of list) {
        if (typeof host !== "string" || !HOSTNAME.test(host)) {
          errors.push({
            code: "SITE_HOST_INVALID",
            site: key,
            message: `Site "${key}" has invalid host "${String(host)}"; use a lowercase hostname without scheme, port, path or wildcard.`,
          });
          continue;
        }

        const identity = `${host}${prefix}`;
        const owner = hostOwner.get(identity);
        if (owner !== undefined && owner !== key) {
          errors.push({
            code: "SITE_HOST_OVERLAP",
            site: key,
            message: `Sites "${owner}" and "${key}" both serve host "${host}" at basePath "${prefix || "/"}".`,
          });
        } else {
          hostOwner.set(identity, key);
        }
      }

      if (!Array.isArray(hosts)) {
        errors.push({
          code: "SITE_HOST_INVALID",
          site: key,
          message: `Site "${key}" has invalid hosts "${String(hosts)}"; it must be an array of hostnames.`,
        });
      }
    }
  }

  if (dynamicSites.length > 0 && !resolveHost) {
    errors.push({
      code: "DYNAMIC_SITE_WITHOUT_RESOLVER",
      site: dynamicSites[0],
      message: `Dynamic site(s) ${dynamicSites.map(name => `"${name}"`).join(", ")} require web.resolveHost, which is not set.`,
    });
  }

  if (resolveHost && dynamicSites.length === 0) {
    errors.push({
      code: "RESOLVER_WITHOUT_DYNAMIC_SITE",
      message: "web.resolveHost is set but no site in web.sites has dynamic: true.",
    });
  }

  if (unknownHost !== undefined && unknownHost !== "not-found" && !(unknownHost in sites)) {
    errors.push({
      code: "UNKNOWN_HOST_SITE_MISSING",
      message: `unknownHost names site "${unknownHost}", which is not defined in web.sites.`,
    });
  }

  return errors;
}

/** Runtime guard for S2: the resolver may only name a declared dynamic site. */
export function assertResolvedSite(resolution: HostResolution, sites: SitesConfig): void {
  const site = sites[resolution.site] as { dynamic?: unknown } | undefined;

  if (!site || site.dynamic !== true) {
    throw new Error(
      `web.resolveHost returned site "${resolution.site}", which is not a dynamic site in web.sites.`,
    );
  }
}
