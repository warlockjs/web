/**
 * The locale-routing table: which URL prefixes carry a locale, read by both
 * the server installers and the browser router.
 *
 * Like the route table, this is boot-time, process-wide state, never written
 * during a request. It lives on `globalThis` under a `Symbol.for` key for
 * the same reason route-table.ts documents. In dev, the installer (tsx graph)
 * and the page modules (Vite SSR graph) are two module instances in one
 * isolate.
 *
 * MULTI-SITE: locale routing is per site (each site's effective routing comes
 * from its own `siteConfig.localeRouting`, over the global setting), so this
 * module also keeps a per-site map alongside the single-site/global value —
 * see {@link publishLocaleRouting} and {@link readLocaleRouting}.
 *
 * Design: releases/v5.17-locale-routing-design-note.md.
 */
import { currentSite } from "./site-url";

/**
 * `none`: no locale in the URL (the default).
 * `prefix`: every locale is prefixed (`/en/posts`, `/ar/posts`).
 * `prefix-except-default`: the default locale is bare (`/posts`), the others are prefixed.
 */
export type LocaleRoutingStrategy = "none" | "prefix" | "prefix-except-default";

export type LocaleRouting = {
  readonly strategy: LocaleRoutingStrategy;
  /** From `app.localeCodes`. */
  readonly codes: readonly string[];
  /** From `app.localeCode`. */
  readonly defaultLocale: string;
};

const LOCALE_ROUTING_SLOT = Symbol.for("warlock.web.localeRouting");

/**
 * `global` is the single-site value (and a multi-site app's fallback, for a
 * request whose site has no entry of its own — there should always be one,
 * but a stale artifact or a partial install should degrade to `"none"` rather
 * than throw). `bySite` only exists in multi-site mode, one entry per site
 * key, published incrementally the same way `route-table.ts`'s
 * `registerSiteRoutes` builds up its own per-site map.
 */
type LocaleRoutingSlot = {
  readonly global: LocaleRouting;
  readonly bySite?: ReadonlyMap<string, LocaleRouting>;
};

type LocaleRoutingHost = typeof globalThis & {
  [LOCALE_ROUTING_SLOT]?: LocaleRoutingSlot;
};

const NO_LOCALE_ROUTING: LocaleRouting = { strategy: "none", codes: [], defaultLocale: "" };

/**
 * Called once at install (server) or hydration entry (browser).
 *
 * Omitting `site` publishes the single-site/global value — the call the
 * single-site installer and the browser hydration entry both make — and
 * leaves any already-published per-site map untouched. Passing `site`
 * publishes THAT site's routing into the per-site map, alongside the others
 * already published; a multi-site install calls this once per site, in the
 * same loop that installs its pages, and never touches another site's entry.
 */
export function publishLocaleRouting(routing: LocaleRouting, site?: string): void {
  const host = globalThis as LocaleRoutingHost;
  const previous = host[LOCALE_ROUTING_SLOT];

  if (site === undefined) {
    host[LOCALE_ROUTING_SLOT] = { global: routing, bySite: previous?.bySite };
    return;
  }

  const bySite = new Map(previous?.bySite);
  bySite.set(site, routing);
  host[LOCALE_ROUTING_SLOT] = { global: previous?.global ?? NO_LOCALE_ROUTING, bySite };
}

/**
 * The routing for the site of the request currently being rendered
 * (`./site-url.ts`'s `currentSite()` — the same ALS-backed resolver `href()`
 * already reads to build a cross-site URL), or the published global/single-site
 * value when there is no current site, or no per-site entry for it. Every
 * single-site app falls in the second case: `currentSite()` never resolves at
 * all there, because nothing ever calls `connectCurrentSite`.
 */
export function readLocaleRouting(): LocaleRouting {
  const slot = (globalThis as LocaleRoutingHost)[LOCALE_ROUTING_SLOT];

  if (slot === undefined) return NO_LOCALE_ROUTING;

  const site = currentSite()?.key;
  const bySiteEntry = site === undefined ? undefined : slot.bySite?.get(site);

  return bySiteEntry ?? slot.global;
}

/**
 * Drop the published table, returning the module to its pre-boot state.
 *
 * Exists for tests: like `route-table.ts`'s `resetRouteTable`, the slot is
 * process-global, so a suite that published a per-site map would otherwise
 * leak it into every later test in the same worker.
 */
export function resetLocaleRouting(): void {
  delete (globalThis as LocaleRoutingHost)[LOCALE_ROUTING_SLOT];
}

/** True when `code` is a locale that appears as a URL prefix under `routing`. */
export function isPrefixedLocale(routing: LocaleRouting, code: string): boolean {
  if (routing.strategy === "none") return false;
  if (routing.strategy === "prefix-except-default" && code === routing.defaultLocale) return false;
  return routing.codes.includes(code);
}
