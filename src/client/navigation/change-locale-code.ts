import type { ReactNode } from "react";
import { hasLeadingLocaleParam } from "../../routing/locale-param-route";
import { withLocalePrefix } from "../../routing/locale-prefixed-paths";
import { isPrefixedLocale, readLocaleRouting } from "../../routing/locale-routing";
import { routePathOf } from "../../routing/route-table";
import { routerEvents, type NavigationMode } from "../../routing/router-events";
import { hydrateShared } from "../../shared";
import { fetchPageData } from "./fetch-page-data";
import type { RefreshRuntime } from "./refresh";
import { syncDocumentLocale } from "./sync-document-locale";

/**
 * Switch the active locale for the current route without a full page reload.
 *
 * ## Why this is a data request, not a navigation
 *
 * The server resolves a request's locale as the first
 * present of a `?locale=` query param, the `locale` cookie, then a `locale`
 * header (`core/src/http/request.ts:352-360`), with the query param
 * outranking everything else. There is no URL-prefix mode. Persisting the
 * choice is therefore the SERVER's job: a navigation data request whose
 * locale came from the query param has the server call
 * `response.setLocale(request.locale)`, which writes the (HttpOnly) cookie
 * the next full load will agree with — the client never writes it itself.
 *
 * So `changeLocaleCode` re-fetches the CURRENT route, exactly like
 * `refresh()`, but with `?locale=<code>` appended to the FETCH URL only. The
 * visible address bar is left alone, except that a `locale` param already
 * sitting in it is stripped — left in place it would keep outranking the
 * cookie the server just persisted, undoing the change on the next reload.
 *
 * ## Locale ROUTING changes the shape of the above (design note §B.3)
 *
 * Everything in this section is unique to an active
 * `web.localeRouting.strategy` (`routing/locale-routing.ts`). Under
 * `"none"` — still the default, and every case above — nothing here applies.
 *
 * Under `prefix`/`prefix-except-default` the locale lives in the URL PATH,
 * not a query param the server resolves, so persisting the choice is a
 * REAL URL change: this re-prefixes the current path for the new code,
 * preserving the query and the hash, and `pushState`s to it — a normal
 * (unmarked) page-data fetch against that same URL, not `?locale=`. The
 * server never has a cookie to persist in this mode (§A.2: the path
 * outranks the cookie), so there is nothing to strip from the address bar
 * either.
 *
 * A `[locale]`-folder page (design note §C.3) gets the identical URL-change
 * treatment, under `strategy: "none"` — the two are mutually exclusive by
 * construction (`LocaleParamRoutingConflictError`, §C.4), so there is never
 * a question of which rule applies. The page on screen is recognised as one
 * by asking the SAME route table `href()` reads (`routePathOf`, never a
 * second matcher — canon `9c8f878b`): the current payload's matched route
 * name has a path whose first segment is `:locale`, and that param's value
 * is the payload's own `locale`. The first path segment is then swapped for
 * the new code directly, with no `isPrefixedLocale` gate — a `[locale]`
 * route has no bare/default case the way `prefix-except-default` does.
 *
 * ## Same runtime as `refresh()`, different question
 *
 * `NavigationRoot` connects one {@link RefreshRuntime} and both `refresh()`
 * and this share it: the page on screen, the swap, the tree builder, and the
 * race counter are one seam because a refresh, a locale change and a
 * navigation can all overtake each other and must share one ticket counter to
 * notice.
 *
 * ## Failure leaves the page exactly as it was
 *
 * Unlike a navigation, a failed locale change never hands the URL to
 * `window.location.assign` — the user is already where they want to be. It
 * also never writes anything: no history change, no tree swap, no cookie (the
 * client holds none to restore). The returned promise rejects so the caller
 * knows the switch did not happen.
 */

/** A locale change is a "replace" for history and its listeners, same as `refresh()`. */
const CHANGE_LOCALE_MODE = "replace" as const;

export type LocaleChanger = (code: string) => Promise<void>;

/** `href` with its `locale` query param set to `code`, every other part kept. */
function withLocaleParam(href: string, code: string): string {
  const url = new URL(href);

  url.searchParams.set("locale", code);

  return url.toString();
}

/**
 * `href` with its `locale` query param removed, or `undefined` when it carried
 * none — so the caller can tell "nothing to clean up" from "cleaned to this".
 */
function withoutLocaleParam(href: string): string | undefined {
  const url = new URL(href);

  if (!url.searchParams.has("locale")) return undefined;

  url.searchParams.delete("locale");

  return url.toString();
}

/** `pathname`'s first segment, e.g. `"ar"` for `/ar/posts`, `""` for `/`. */
function firstPathSegment(pathname: string): string {
  const slashIndex = pathname.indexOf("/", 1);

  return slashIndex === -1 ? pathname.slice(1) : pathname.slice(1, slashIndex);
}

/** `pathname` with its first segment removed, e.g. `/ar/posts` → `/posts`, `/ar` → `/`. */
function pathWithoutFirstSegment(pathname: string): string {
  const slashIndex = pathname.indexOf("/", 1);

  return slashIndex === -1 ? "/" : pathname.slice(slashIndex);
}

/**
 * `href`'s PATH re-prefixed for `code`, under an active
 * `web.localeRouting.strategy` (design note §B.3) — the query and hash are
 * carried over untouched, and an existing routed-locale prefix on the
 * current path is stripped first so this never double-prefixes.
 *
 * `undefined` is a legal `nextLocale`-shaped segment too: `isPrefixedLocale`
 * already answers "not a prefix" for the default locale under
 * `"prefix-except-default"`, so re-prefixing FOR the default naturally
 * produces the bare path, and re-prefixing FROM it is a no-op strip (the
 * default was never in the URL to begin with).
 */
function reprefixedUrl(href: string, code: string): string {
  const url = new URL(href);
  const routing = readLocaleRouting();
  const firstSegment = firstPathSegment(url.pathname);
  const strippedPath =
    firstSegment !== "" && isPrefixedLocale(routing, firstSegment)
      ? pathWithoutFirstSegment(url.pathname)
      : url.pathname;

  url.pathname = isPrefixedLocale(routing, code)
    ? withLocalePrefix(strippedPath, code)
    : strippedPath;

  return url.toString();
}

/**
 * `href`'s PATH re-prefixed for `code`, for a `[locale]`-folder page (design
 * note §C.3) — the query and hash are carried over untouched, and the
 * current first path segment is unconditionally replaced: unlike
 * {@link reprefixedUrl}, a `[locale]` route has no bare/default-locale case
 * to gate on ({@link isPrefixedLocale} is a `web.localeRouting.strategy`
 * concept, and the two never coexist — §C.4), and the caller has already
 * confirmed that first segment IS the current locale before reaching here.
 */
function reprefixedUrlForLocaleParam(href: string, code: string): string {
  const url = new URL(href);

  url.pathname = withLocalePrefix(pathWithoutFirstSegment(url.pathname), code);

  return url.toString();
}

/**
 * Whether the page on screen is `[locale]`-routed (design note §C) — its
 * matched route's path has `:locale` as its FIRST segment, and that param
 * resolved to the payload's own `locale`. Reads the same published route
 * table `href()` reads (`routePathOf`), never a second matcher (canon
 * `9c8f878b`).
 *
 * `payload.params` is the key `README`/`hydration-payload.ts` documents as
 * OPTIONAL — an older build, or a document cached across a deploy — and its
 * absence answers `false` here rather than guessing.
 */
function isLocaleParamRoute(payload: {
  readonly name: string;
  readonly locale: string;
  readonly params?: Readonly<Record<string, string>>;
}): boolean {
  if (payload.params?.locale !== payload.locale) return false;

  const path = routePathOf(payload.name);

  return path !== undefined && hasLeadingLocaleParam(path);
}

/**
 * Build the runtime's locale changer.
 *
 * Called by `NavigationRoot`, which connects the result with
 * {@link connectLocaleChanger}. Not part of the public surface — a caller
 * holding its own changer would be switching the locale of a page it does not
 * own.
 */
export function createLocaleChanger(runtime: RefreshRuntime): LocaleChanger {
  return async (code: string) => {
    // Universal module, same reasoning as `refresh()`: safe to call during a
    // server render or before hydration connects the runtime, and there is
    // nothing to do there.
    if (typeof window === "undefined") return;

    // Calling with the current locale does nothing — no request, no history
    // write, no event.
    if (runtime.readCurrent().payload.locale === code) return;

    const url = window.location.href;

    // Under an active strategy, OR on a `[locale]`-folder page (design note
    // §C.3; the two never coexist, §C.4), the locale lives in the URL PATH,
    // so the switch is a real URL change — pushState, and a normal
    // (unmarked) page-data fetch against the re-prefixed URL — instead of
    // the `?locale=` fetch-only param this module used exclusively before
    // locale routing existed. Neither keeps that exact original behaviour
    // otherwise: there is no prefix to move, so the address bar is left
    // alone and the choice travels to the server as a query param instead.
    const routing = readLocaleRouting();
    const usesLocaleRouting = routing.strategy !== "none";
    const usesLocaleParamRoute =
      !usesLocaleRouting && isLocaleParamRoute(runtime.readCurrent().payload);
    const pathCarriesLocale = usesLocaleRouting || usesLocaleParamRoute;
    const targetUrl = usesLocaleRouting
      ? reprefixedUrl(url, code)
      : usesLocaleParamRoute
        ? reprefixedUrlForLocaleParam(url, code)
        : url;
    const fetchUrl = pathCarriesLocale ? targetUrl : withLocaleParam(url, code);
    const mode: NavigationMode = pathCarriesLocale ? "push" : CHANGE_LOCALE_MODE;
    const { isCurrent, signal } = runtime.claimTicket();

    routerEvents.emitNavigating({ url, mode });

    const result = await fetchPageData(fetchUrl, signal);

    // Superseded: a navigation or another locale change already answered this
    // question. Not an error — the operation that overtook this one emits its
    // own outcome. Covers `result.type === "aborted"` too, which `isCurrent()`
    // catches on its own — the ticket, not the abort, is what decided this.
    if (!isCurrent() || result.type === "aborted") return;

    if (result.type === "hard-navigate") {
      const error = new Error(`Warlock changeLocaleCode failed: ${result.reason}`);

      console.warn("Warlock changeLocaleCode could not re-fetch the current page:", result.reason);
      routerEvents.emitNavigationError({ url, mode, error });

      throw error;
    }

    let tree: ReactNode;

    try {
      tree = await runtime.buildTree(result.payload);
    } catch (error) {
      console.warn("Warlock changeLocaleCode could not build the page tree:", error);
      routerEvents.emitNavigationError({ url, mode, error });

      throw error;
    }

    if (!isCurrent()) return;

    // Shared state BEFORE the render that consumes it, exactly as a
    // navigation and a refresh do it.
    hydrateShared(result.payload.shared);

    // Corrected HERE, synchronously, rather than left to `NavigationRoot`'s
    // own `current.payload.locale`-keyed effect (`navigation-root.tsx`):
    // that effect only runs on React's NEXT commit, after this function's
    // own promise has already resolved, so a caller reading
    // `document.documentElement` right after `await changeLocaleCode(...)`
    // would still see the OLD locale. `NavigationRoot`'s effect still runs
    // afterwards — its own write is a no-op once this one has already made
    // `documentElement` agree (`syncDocumentLocale` skips a write that is
    // already correct) — so the two never fight, this one just wins the race.
    syncDocumentLocale(document, result.payload.locale);

    const previous = runtime.readCurrent();
    const sameEntry = result.payload.name === previous.payload.name;

    if (pathCarriesLocale) {
      // A REAL URL change: the new prefix is the address for this page now,
      // not a fetch-only marker to clean up — `pushState`, same as a plain
      // navigation, so Back returns to the previous locale's URL.
      window.history.pushState(null, "", targetUrl);
    } else {
      // The visible URL is left alone UNLESS it already carried a `locale`
      // query param — left in place, that param would outrank the cookie the
      // server just persisted (`request.ts:352-360`) and silently revert the
      // locale on the next reload.
      const cleanedUrl = withoutLocaleParam(url);

      if (cleanedUrl !== undefined) {
        window.history.replaceState(null, "", cleanedUrl);
      }
    }

    // This is not a move: the route the user is looking at did not change,
    // only its locale did. Carrying the previous `routeSource` forward keeps
    // `previousRoute()` from naming the page the user is already on — the same
    // rule `refresh()` follows for the same reason.
    runtime.writeCurrent({
      payload: result.payload,
      tree,
      routeSource: sameEntry ? previous.routeSource : result.payload,
    });

    // `result.url` is the URL the response actually came from. Without a
    // path-carried locale it is the FETCH url, which always carries the
    // `?locale=` this module added — reporting it verbatim would announce a
    // URL that was never, and is never meant to be, on the address bar, so
    // it is stripped back off. With a path-carried locale the fetch URL IS
    // the visible URL (no marker was ever added), so `result.url` is
    // reported as-is.
    const resolvedUrl = pathCarriesLocale
      ? result.url
      : (withoutLocaleParam(result.url) ?? result.url);

    routerEvents.emitNavigated({ url, resolvedUrl, mode });
  };
}

let connected: LocaleChanger | undefined;

/**
 * Installed by the navigation runtime at mount, and torn down with `undefined`.
 *
 * The same seam shape as `connectRefresher` — {@link changeLocaleCode} is
 * universal and must not import the client runtime, so the runtime registers
 * itself instead.
 *
 * @returns the previous changer, so a caller that installs one can restore
 * what was there.
 */
export function connectLocaleChanger(next: LocaleChanger | undefined): LocaleChanger | undefined {
  const previous = connected;

  connected = next;

  return previous;
}

/**
 * Switch the active locale without a full page reload.
 *
 * Re-fetches the current route's data with `?locale=code` on the request URL
 * only, then swaps the rendered page in — `useLocale()` and `useTextDirection()`
 * follow from the new payload's `locale` in the same render. `root.tsx` sits
 * outside the hydrated subtree (`skills/write-the-root/SKILL.md`), so no
 * client render can reach it directly; this function corrects
 * `document.documentElement`'s `lang`/`dir` imperatively itself
 * (`sync-document-locale.ts`), synchronously, before its own promise
 * resolves — `NavigationRoot` also corrects it, in an effect keyed on the
 * payload's `locale` (`navigation-root.tsx`), the same shape it already uses
 * to correct `<head>` after a swap, but that effect only runs on React's
 * NEXT commit, after this function has already returned; a caller checking
 * `document.documentElement` right after `await changeLocaleCode(...)` must
 * not see the OLD locale. The server persists the choice (the framework's
 * `locale` cookie) on that same request, so the next full load agrees.
 *
 * Calling it with the locale already active is a no-op: no request is made.
 *
 * @throws when the network request fails, the server cannot be reached, or
 * the fresh page cannot be built. The active locale and any cookie already on
 * the browser are left exactly as they were — nothing here writes a cookie,
 * so there is nothing to roll back.
 *
 * @returns a promise that resolves once the new locale is on screen. Safe to
 * call anywhere: it resolves immediately, doing nothing, when no client
 * runtime is connected (a server render, or before hydration) or when `code`
 * is already the active locale.
 *
 * ```ts
 * await changeLocaleCode("ar");
 * ```
 */
export async function changeLocaleCode(code: string): Promise<void> {
  if (!connected) return;

  return connected(code);
}
