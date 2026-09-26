/** Request-scoped site origin helpers. The server connects the resolver once at boot. */
export type CurrentSite = {
  readonly key: string;
  readonly host: string;
  readonly basePath: string;
  readonly protocol?: string;
  readonly port?: string;
};

export type CurrentSiteResolver = () => CurrentSite | undefined;

let resolveCurrentSite: CurrentSiteResolver | undefined;
let browserSite: Pick<CurrentSite, "key" | "basePath"> | undefined;

/** Connect core's ALS-backed request reader without making the client bundle import core. */
export function connectCurrentSite(resolve: CurrentSiteResolver | undefined): CurrentSiteResolver | undefined {
  const previous = resolveCurrentSite;
  resolveCurrentSite = resolve;
  return previous;
}

/** The current site on the server; browser callers have an origin but no site key. */
export function currentSite(): CurrentSite | undefined {
  const serverSite = resolveCurrentSite?.();
  if (serverSite !== undefined || typeof location === "undefined" || browserSite === undefined) return serverSite;
  return { ...browserSite, host: location.hostname, protocol: location.protocol, port: location.port };
}

/** Hydration installs the active client site; it contains no resolver or request data. */
export function registerClientSite(site: Pick<CurrentSite, "key" | "basePath"> | undefined): void {
  browserSite = site;
}

function requestProtocolAndPort(): { protocol: string; port: string } {
  const site = currentSite();
  if (site !== undefined) return { protocol: site.protocol ?? "https:", port: site.port ?? "" };
  if (typeof location !== "undefined") return { protocol: location.protocol, port: location.port };
  return { protocol: "https:", port: "" };
}

/** Build an origin using this request's scheme and non-default development port. */
export function siteOriginFor(host: string): string {
  const { protocol, port } = requestProtocolAndPort();
  const hostHasPort = host.startsWith("[") ? host.includes("]:") : host.includes(":");
  return `${protocol}//${host}${hostHasPort || port === "" ? "" : `:${port}`}`;
}

/** Current origin plus the site's path mount. Safe in browser and server code. */
export function siteUrl(): string {
  const site = currentSite();
  if (site !== undefined) return `${siteOriginFor(site.host)}${site.basePath}`;
  if (typeof location !== "undefined") return `${location.origin}${browserSite?.basePath ?? ""}`;
  return "https://";
}
