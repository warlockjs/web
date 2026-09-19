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
 * Design: releases/v5.17-locale-routing-design-note.md.
 */

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

type LocaleRoutingHost = typeof globalThis & {
  [LOCALE_ROUTING_SLOT]?: LocaleRouting;
};

const NO_LOCALE_ROUTING: LocaleRouting = { strategy: "none", codes: [], defaultLocale: "" };

/** Called once at install (server) or hydration entry (browser). */
export function publishLocaleRouting(routing: LocaleRouting): void {
  (globalThis as LocaleRoutingHost)[LOCALE_ROUTING_SLOT] = routing;
}

/** The published routing, or strategy `none` when nothing was published. */
export function readLocaleRouting(): LocaleRouting {
  return (globalThis as LocaleRoutingHost)[LOCALE_ROUTING_SLOT] ?? NO_LOCALE_ROUTING;
}

/** True when `code` is a locale that appears as a URL prefix under `routing`. */
export function isPrefixedLocale(routing: LocaleRouting, code: string): boolean {
  if (routing.strategy === "none") return false;
  if (routing.strategy === "prefix-except-default" && code === routing.defaultLocale) return false;
  return routing.codes.includes(code);
}
