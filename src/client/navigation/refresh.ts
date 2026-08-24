import type { ReactNode } from "react";
import type { HydrationDocumentPayloadSource } from "../../hydration-payload";
import { routerEvents } from "../../routing/router-events";
import { hydrateShared } from "../../shared";
import { fetchPageData } from "./fetch-page-data";

/**
 * Re-run the current route's loaders and re-render it — under MRR's name.
 *
 * ## The name is MRR's; the behaviour is deliberately stronger
 *
 * `@mongez/react-router`'s `refresh()` re-RENDERS the current route: it is a
 * CSR router, all the data is already in the browser, and there is nothing to
 * go and get. Warlock's page data comes from the server, so re-rendering alone
 * would show the user exactly what they were already looking at. This
 * `refresh()` therefore re-FETCHES first — the same `x-warlock-data` request a
 * client navigation makes — and then swaps the page in. Strictly more than the
 * name promises elsewhere, never less, which is why the name could be kept.
 *
 * That difference is stated on {@link refresh} itself and not only here,
 * because the developer who needs to know it is the one hovering the symbol.
 *
 * ## Why the failure mode is the opposite of a navigation's
 *
 * `fetch-page-data.ts` degrades EVERY failure to a real browser load, and that
 * is right for a navigation: the user asked to go somewhere and must arrive.
 * A refresh is the opposite situation — the user is already where they want to
 * be. Handing the URL to `window.location.assign` would throw away their scroll
 * position, their open dialogs and the form they just posted from, in exchange
 * for data they only asked to update. So a failed refresh keeps the page
 * exactly as it is and announces the error; the screen the user has is never
 * the price of a network blip.
 *
 * ## Not server actions
 *
 * The mutation is an ordinary POST to the API, and this is what you call after
 * it. Nothing here writes; nothing here knows a mutation happened.
 */

/**
 * The page on screen, as the navigation runtime holds it.
 *
 * `routeSource` is the reason this type is not simply `{ payload, tree }`. See
 * {@link createRefresher} for what it carries and why it is separate from
 * `payload`.
 */
export type RefreshablePage = {
  /** What the tree was built from — what the document context reports. */
  payload: HydrationDocumentPayloadSource;
  /** The rendered page. */
  tree: ReactNode;
  /**
   * The payload object `current-route.ts` identifies the current ROUTE by,
   * which is the same object as `payload` after a navigation but NOT after a
   * refresh.
   */
  routeSource: HydrationDocumentPayloadSource;
};

/**
 * Everything a refresh needs that only `NavigationRoot` can provide.
 *
 * Injected rather than reached for, and kept to four members: the page on
 * screen, the swap, the tree builder, and the race counter. Everything else a
 * refresh does — the request, the shared snapshot, the address bar, the
 * lifecycle events — is this module's own and is not injected, so a test
 * exercises the real ones.
 */
export type RefreshRuntime = {
  /** The page on screen at the moment it is asked for, never a captured copy. */
  readCurrent: () => RefreshablePage;
  /** Put a page on screen. */
  writeCurrent: (page: RefreshablePage) => void;
  /** How a payload becomes a tree, with the page registry already bound. */
  buildTree: (payload: HydrationDocumentPayloadSource) => Promise<ReactNode>;
  /**
   * Take a ticket from the navigation runtime's race counter.
   *
   * @returns a predicate that answers whether this operation is still the
   * newest one. THE SAME counter navigations take their tickets from — a
   * refresh and a navigation can overtake each other, so a second mechanism
   * would simply fail to notice.
   */
  claimTicket: () => () => boolean;
};

/**
 * What {@link refresh} delegates to once the runtime has connected itself.
 *
 * @returns `true` when fresh data is on screen. `false` covers every other
 * outcome — no runtime, no browser, the request failed, or a newer operation
 * overtook this one — and none of them left the page in a worse state than
 * they found it.
 */
export type Refresher = () => Promise<boolean>;

/**
 * A refresh is a "replace" as far as history and its listeners are concerned:
 * no entry is pushed, and one may be replaced when the server redirects.
 */
const REFRESH_MODE = "replace" as const;

/**
 * Build the runtime's refresher.
 *
 * Called by `NavigationRoot`, which connects the result with
 * {@link connectRefresher}. Not part of the public surface — a caller holding
 * its own refresher would be refreshing a page it does not own.
 *
 * ## The `routeSource` decision, which lives here
 *
 * `recordCurrentRoute` (`current-route.ts`) recognises a route by its payload
 * OBJECT IDENTITY: one swap is one payload object, which is what keeps a
 * StrictMode double render from counting as a navigation. A refresh breaks that
 * assumption on its own, because it produces a brand new payload object for the
 * page already on screen — so recording it would shift `previousRoute()` to the
 * page the user is currently looking at, and a "back to where I came from" link
 * would point at itself.
 *
 * So a refresh that came back as the SAME entry carries the previous
 * `routeSource` forward untouched: the fresh payload renders, and the route
 * does not move, because it did not. A refresh that came back as a DIFFERENT
 * entry — a session expiring into `/login` is the ordinary cause — is a real
 * move the server made, and is recorded as one; anything else would leave
 * `currentRoute()` naming a page that is no longer on screen.
 *
 * Comparing `name` here is not route matching (canon `9c8f878b`): both names
 * were decided by the server's router and merely travelled here. Nothing in
 * this file looks at a path.
 */
export function createRefresher(runtime: RefreshRuntime): Refresher {
  return async () => {
    // Not merely defensive: `refresh()` is importable from a universal module,
    // so a component can call it during the server render. There is no page on
    // screen to refresh there, and no address bar to read one from.
    if (typeof window === "undefined") return false;

    // The address bar IS the current route's URL — the runtime has already put
    // the resolved URL there — so there is no second copy to drift from it.
    const url = window.location.href;
    const isCurrent = runtime.claimTicket();

    routerEvents.emitNavigating({ url, mode: REFRESH_MODE });

    const result = await fetchPageData(url);

    // Superseded, and silently: this is the answer to a question the user
    // stopped asking. Not an error, and not an event — the operation that
    // overtook this one emits its own outcome.
    if (!isCurrent()) return false;

    if (result.type === "hard-navigate") {
      /*
        NO `window.location.assign` HERE, and this line is the whole point of
        the file. `fetchPageData` reports a hard navigation because that is the
        correct degradation for GOING somewhere; for STAYING somewhere it would
        destroy the screen the user already has in order to deliver data they
        asked to update. The page stays; the error is announced.
      */
      const error = new Error(`Warlock refresh failed: ${result.reason}`);

      console.warn("Warlock refresh could not re-fetch the current page:", result.reason);
      routerEvents.emitNavigationError({ url, mode: REFRESH_MODE, error });

      return false;
    }

    let tree: ReactNode;

    try {
      tree = await runtime.buildTree(result.payload);
    } catch (error) {
      // A stale bundle after a deploy is the realistic cause. A navigation
      // reloads to fix it; a refresh cannot, for the same reason as above.
      console.warn("Warlock refresh could not build the page tree:", error);
      routerEvents.emitNavigationError({ url, mode: REFRESH_MODE, error });

      return false;
    }

    if (!isCurrent()) return false;

    // Shared state BEFORE the render that consumes it, exactly as a navigation
    // does it — a refresh can carry a changed locale or a changed user too.
    hydrateShared(result.payload.shared);

    const previous = runtime.readCurrent();
    const sameEntry = result.payload.name === previous.payload.name;

    /*
      Only when the server actually moved us — `result.url` is the absolute URL
      the response came from and `url` came from the address bar, so they differ
      only when a redirect was followed. REPLACE even then: a refresh is not a
      destination, and pushing would make Back need two presses to leave a page
      the user never chose to visit twice.

      Keyed on the URL, not on `sameEntry`: the address bar's job is to name the
      URL on screen, and a redirect that stayed within one route entry
      (`?page=2` collapsing to `?page=1`) has still changed it.
    */
    if (result.url !== url) {
      window.history.replaceState(null, "", result.url);
    }

    runtime.writeCurrent({
      payload: result.payload,
      tree,
      routeSource: sameEntry ? previous.routeSource : result.payload,
    });

    routerEvents.emitNavigated({ url, resolvedUrl: result.url, mode: REFRESH_MODE });

    return true;
  };
}

let connected: Refresher | undefined;

/**
 * Installed by the navigation runtime at mount, and torn down with `undefined`.
 *
 * The same seam shape as `routing/navigator.ts`, and for the same reason:
 * {@link refresh} is universal and must not import the client runtime, so the
 * runtime registers itself instead.
 *
 * @returns the previous refresher, so a caller that installs one can restore
 * what was there.
 */
export function connectRefresher(next: Refresher | undefined): Refresher | undefined {
  const previous = connected;

  connected = next;

  return previous;
}

/**
 * Re-fetch the current route's data and re-render the page with it.
 *
 * What you call after a mutation — a normal POST to your API, then this — to
 * put the server's new truth on screen without a full reload. The layout stays
 * mounted, so scroll position, open menus and playing media survive.
 *
 * ## Stronger than the `refresh()` you may know
 *
 * `@mongez/react-router`'s `refresh()` only RE-RENDERS the current route. This
 * one RE-FETCHES the route's data first and then re-renders, because in Warlock
 * the data lives on the server and a re-render alone would show the user what
 * they are already looking at. Anywhere MRR's `refresh()` was correct, this is
 * too; it simply also picks up what changed.
 *
 * ## It cannot cost you the page
 *
 * If the request fails — offline, a 500, a proxy answering HTML — the page on
 * screen is left exactly as it was and `false` comes back. There is no reload
 * and no error screen. Subscribe to `routerEvents.onNavigationError` to show
 * the user something.
 *
 * ```ts
 * await api.post("/products", form);
 *
 * if (!(await refresh())) toast.error("Could not reload the list.");
 * ```
 *
 * @returns `true` when fresh data is on screen. `false` when nothing was
 * applied: no client runtime is connected (a server render, or before
 * hydration), the re-fetch failed, or a navigation overtook the refresh. Safe
 * to call in any of those — it never throws.
 */
export async function refresh(): Promise<boolean> {
  if (!connected) return false;

  return connected();
}
