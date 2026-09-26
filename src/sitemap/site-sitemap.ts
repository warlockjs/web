import { config, type Request } from "@warlock.js/core";
import { Sitemap, type SitemapEntry } from "@warlock.js/sitemap";
import { createSiteSelector, type SiteSelection } from "../sites/site-selector";
import type { SitesConfig } from "../sites/site-config.types";
import { collectSitemapEntries } from "./collect-sitemap-entries";
import { resolveSitemapConfig } from "./resolve-sitemap-config";
import type { SitemapPageSource } from "./sitemap-page-source";

type MultiSiteWebConfig = {
  sites?: SitesConfig;
  resolveHost?: Parameters<typeof createSiteSelector>[0]["resolveHost"];
  resolveCache?: Parameters<typeof createSiteSelector>[0]["resolveCache"];
  unknownHost?: Parameters<typeof createSiteSelector>[0]["unknownHost"];
};

export type SelectedSitemapSite = Extract<SiteSelection, { kind: "site" }>;

export function multiSiteConfig(): MultiSiteWebConfig | undefined {
  const web = config.get("web", {}) as MultiSiteWebConfig;
  return web.sites === undefined ? undefined : web;
}

export function createSitemapSiteSelector() {
  const web = multiSiteConfig();
  if (!web?.sites) return undefined;

  return createSiteSelector({
    sites: web.sites,
    resolveHost: web.resolveHost,
    resolveCache: web.resolveCache,
    unknownHost: web.unknownHost,
  });
}

function createRootSiteSelector() {
  const web = multiSiteConfig();
  if (!web?.sites) return undefined;
  const sites = Object.fromEntries(
    Object.entries(web.sites).map(([key, site]) => {
      const { basePath: _basePath, ...rootSite } = site;
      return [key, rootSite];
    }),
  ) as SitesConfig;

  return createSiteSelector({
    sites,
    resolveHost: web.resolveHost,
    resolveCache: web.resolveCache,
    unknownHost: web.unknownHost,
  });
}

/** Selects a non-page route with the exact same policy as page dispatch. */
export async function selectSitemapSite(
  request: Request,
  selector = createSitemapSiteSelector(),
): Promise<SiteSelection | undefined> {
  if (!selector) return undefined;
  const input = {
    rawHost: request.baseRequest.hostname,
    path: request.path.split("?")[0] || "/",
    request,
  };
  const selected = await selector.select(input);
  if (selected.kind !== "not-found") return selected;

  // `/robots.txt` and `/sitemap.xml` live at the host root, so a site's
  // page-only basePath must not make its own SEO endpoints unselectable.
  const rootSelector = createRootSiteSelector();
  if (!rootSelector) return selected;
  const rootSelected = await rootSelector.select(input);
  if (rootSelected.kind === "not-found") return selected;

  const web = multiSiteConfig();
  return {
    ...rootSelected,
    basePath: web?.sites?.[rootSelected.site]?.basePath ?? "",
  };
}

function nonDefaultPort(request: Request): string {
  const host = request.header("host");
  const match = typeof host === "string" ? host.trim().match(/:(\d+)$/) : undefined;
  if (!match) return "";
  const port = match[1];
  if (
    (request.protocol === "https" && port === "443") ||
    (request.protocol === "http" && port === "80")
  )
    return "";
  return `:${port}`;
}

/** The public origin for a selected site, preserving an explicit non-default Host port. */
export function sitemapSiteBaseUrl(request: Request, site: SelectedSitemapSite): string {
  return `${request.protocol}://${site.host}${nonDefaultPort(request)}${site.basePath}`;
}

function removeBasePath(path: string, basePath: string): string {
  if (!basePath || path === basePath) return path === basePath ? "/" : path;
  return path.startsWith(`${basePath}/`) ? path.slice(basePath.length) : path;
}

function localEntry(entry: SitemapEntry, basePath: string): SitemapEntry {
  return {
    ...entry,
    path: removeBasePath(entry.path, basePath),
    ...(entry.alternates === undefined
      ? {}
      : {
          alternates: entry.alternates.map((alternate) => ({
            ...alternate,
            path: removeBasePath(alternate.path, basePath),
          })),
        }),
  };
}

/** Builds an in-memory, host-scoped sitemap. Dynamic tenants are never cached or enumerated. */
export async function buildSiteSitemapXml({
  request,
  site,
  appRoot,
  pageSource,
}: {
  request: Request;
  site: SelectedSitemapSite;
  appRoot?: string;
  pageSource?: SitemapPageSource;
}): Promise<string> {
  const web = multiSiteConfig();
  if (!web?.sites) throw new Error("buildSiteSitemapXml requires web.sites.");

  const resolved = resolveSitemapConfig();
  const collected = await collectSitemapEntries({
    appRoot: appRoot ?? process.cwd(),
    sites: web.sites,
    locales: resolved.locales,
    site: site.site,
    pageSource,
  });
  const sitemap = new Sitemap({ baseUrl: sitemapSiteBaseUrl(request, site), ...resolved.defaults });
  for (const item of collected.items) sitemap.add(localEntry(item.entry, site.basePath));
  return sitemap.toXML();
}

export function isNonIndexableDynamicSite(site: SelectedSitemapSite): boolean {
  return site.resolution !== undefined && site.resolution.indexable !== true;
}
