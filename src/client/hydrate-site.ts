import { publishRouteTable, type RegisteredSites, type RouteTableEntry } from "../routing/route-table";
import { registerClientSite } from "../routing/site-url";

const CLIENT_ROUTE_TABLE_SLOT = "warlock.web.clientRouteTable";

/** The site that supplied this document's hydration entry, outside the payload wire. */
let hydrationSite: string | undefined;

type ClientRouteTable = {
  entries: readonly RouteTableEntry[];
  sites?: RegisteredSites;
};

export function installHydrationSite(document: Document): void {
  hydrationSite = undefined;

  const routeTable = (globalThis as typeof globalThis & {
    [key: symbol]: ClientRouteTable | undefined;
  })[Symbol.for(CLIENT_ROUTE_TABLE_SLOT)];

  // Single-site bundles carry no per-site seed: leave the document untouched,
  // exactly as hydration behaved before multi-site existed.
  if (routeTable?.sites === undefined) return;

  hydrationSite = document
    .querySelector<HTMLScriptElement>('script[type="module"][data-warlock-site]')
    ?.dataset.warlockSite;

  if (hydrationSite === undefined) return;

  publishRouteTable(routeTable.entries, "hydration client entry", routeTable.sites);
  registerClientSite({
    key: hydrationSite,
    basePath: routeTable.sites[hydrationSite]?.basePath ?? "",
  });
}

export function currentHydrationSite(): string | undefined {
  return hydrationSite;
}
