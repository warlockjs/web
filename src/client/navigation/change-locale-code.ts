import type { ReactNode } from "react";
import { routerEvents } from "../../routing/router-events";
import { hydrateShared } from "../../shared";
import { fetchPageData } from "./fetch-page-data";
import type { RefreshRuntime } from "./refresh";

/**
 * Switch the active locale for the current route without a full page reload.
 *
 * ## Why this is a data request, not a navigation
 *
 * Card 2eb7ea7a, Step 0: the server resolves a request's locale as the first
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
    const fetchUrl = withLocaleParam(url, code);
    const isCurrent = runtime.claimTicket();

    routerEvents.emitNavigating({ url, mode: CHANGE_LOCALE_MODE });

    const result = await fetchPageData(fetchUrl);

    // Superseded: a navigation or another locale change already answered this
    // question. Not an error — the operation that overtook this one emits its
    // own outcome.
    if (!isCurrent()) return;

    if (result.type === "hard-navigate") {
      const error = new Error(`Warlock changeLocaleCode failed: ${result.reason}`);

      console.warn("Warlock changeLocaleCode could not re-fetch the current page:", result.reason);
      routerEvents.emitNavigationError({ url, mode: CHANGE_LOCALE_MODE, error });

      throw error;
    }

    let tree: ReactNode;

    try {
      tree = await runtime.buildTree(result.payload);
    } catch (error) {
      console.warn("Warlock changeLocaleCode could not build the page tree:", error);
      routerEvents.emitNavigationError({ url, mode: CHANGE_LOCALE_MODE, error });

      throw error;
    }

    if (!isCurrent()) return;

    // Shared state BEFORE the render that consumes it, exactly as a
    // navigation and a refresh do it.
    hydrateShared(result.payload.shared);

    const previous = runtime.readCurrent();
    const sameEntry = result.payload.name === previous.payload.name;

    // The visible URL is left alone UNLESS it already carried a `locale`
    // query param — left in place, that param would outrank the cookie the
    // server just persisted (`request.ts:352-360`) and silently revert the
    // locale on the next reload.
    const cleanedUrl = withoutLocaleParam(url);

    if (cleanedUrl !== undefined) {
      window.history.replaceState(null, "", cleanedUrl);
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

    // `result.url` is the FETCH URL the response actually came from, which
    // always carries the `?locale=` this module added — reporting it verbatim
    // would announce a URL that was never, and is never meant to be, on the
    // address bar. Strip it back off so listeners (a progress bar included)
    // see the same URL shape a navigation or a refresh would report.
    const resolvedUrl = withoutLocaleParam(result.url) ?? result.url;

    routerEvents.emitNavigated({ url, resolvedUrl, mode: CHANGE_LOCALE_MODE });
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
 * only, then swaps the rendered page in — `useLocale()`, `useTextDirection()`
 * and the root `<html lang dir>` all follow from the new payload's `locale` in
 * the same render. The server persists the choice (the framework's `locale`
 * cookie) on that same request, so the next full load agrees.
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
