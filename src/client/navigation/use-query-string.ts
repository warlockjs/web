import { useCallback, useRef, useSyncExternalStore } from "react";
import {
  currentSearch,
  queryString,
  type QueryStringObject,
  type QueryStringValue,
} from "../../routing/query-string";
import { routerEvents } from "../../routing/router-events";

/**
 * The client half of the query-string ruling (canon `f2e514c0`): `shared` is
 * an SSR-time snapshot that silently disagrees with `location.search` after a
 * client `Link` navigation, so both sides were told to read the URL instead —
 * `queryStringOf` (`routing/query-string.ts`) is the server's half, this is
 * the browser's.
 *
 * ## Why re-reading `location.search` is not enough on its own
 *
 * A `Link` navigation is not a browser history event from React's point of
 * view — no `popstate` fires, `navigation-root.tsx`'s `apply()` moves the URL
 * with `pushState`/`replaceState` directly — so a component that reads the
 * query string once and never again would render a stale value for the rest
 * of the session the moment a `<Link>` changed only the query string. This
 * hook subscribes to `routerEvents.onNavigated` (`routing/router-events.ts`),
 * the framework's OWN navigation lifecycle, which `navigation-root.tsx` fires
 * for both a `<Link>` navigation and Back/Forward — the one signal that is
 * live for everything that can move the query string, `popstate` included.
 *
 * ## Parity with `queryStringOf`
 *
 * Reuses `queryString.parse`, not a second parser: it is universal-safe (its
 * own doc — "safe to import and to CALL with no DOM"), so re-implementing it
 * here would be exactly the two-independently-written-query-string-parsers
 * defect `routing/query-string.ts`'s header exists to prevent (canon
 * `1ca1e8ae`'s shape), applied to reading instead of writing.
 */

/**
 * What {@link readQueryStringValue} caches its last parse in — the exact shape
 * a `useRef` holds, so the hook can hand its ref straight through with no
 * cast.
 */
export type QueryStringCache = { current: { search: string; all: QueryStringObject } | undefined };

/**
 * The snapshot read, extracted from the hook so it is callable — and its
 * caching provably correct — with no React renderer (`refresh.spec.ts`
 * records why this package's test suite cannot mount one: `node` environment,
 * no DOM dependency, so a hook's effects never run).
 *
 * Cached by the raw search string, not recomputed on every call: `decode()`
 * (via `queryString.parse`) builds a fresh object each time it runs, and
 * `useSyncExternalStore` requires a snapshot function that returns the SAME
 * reference for an unchanged store — a fresh object every call is an infinite
 * re-render loop the moment `key` names an array or a bag.
 */
export function readQueryStringValue(
  key: string,
  cache: QueryStringCache,
): QueryStringValue | undefined {
  const search = currentSearch();
  const cached = cache.current;
  const all =
    cached !== undefined && cached.search === search ? cached.all : queryString.parse(search);

  if (cached === undefined || cached.search !== search) {
    cache.current = { search, all };
  }

  return key in all ? all[key] : undefined;
}

/**
 * One value from the current query string, live across client navigation.
 *
 * @param key the query key to read.
 *
 * @returns the decoded value at `key` — a string, an array (`key[]`) or a
 * one-level bag (`key[sub]`), the same three shapes `queryString.parse`
 * produces. **Absent is `undefined`, never `""`**: an absent key and a
 * present-but-empty one (`?q=`, which parses to `""`) are different values,
 * and returning `""` for both would erase that difference for every caller.
 * There is no default-value parameter for the same reason — the caller
 * decides what "absent" means for its own UI, this hook only reports it.
 *
 * **SSR**: during a server render, this reads the search string of the
 * REQUEST being rendered (via `connectRequestSearch`,
 * `routing/query-string.ts`), not `undefined` and not a thrown error, so the
 * value the server sends down is the value the first client render computes
 * too — the two renders match and hydration does not mismatch. Before the
 * pipeline connects that resolver, the server side reads as `""` (no query),
 * matching `browserSearch()`'s own "nothing to report yet" answer outside a
 * document.
 *
 * Re-renders the calling component when a client navigation completes —
 * `<Link>`, `navigateTo()`, or Back/Forward — and the query string it reads
 * changed as a result. Safe to call during a server render and before
 * hydration; there is nothing to subscribe to in either case and the value is
 * simply read once.
 */
export function useQueryString(key: string): QueryStringValue | undefined {
  const cache: QueryStringCache = useRef<QueryStringCache["current"]>(undefined);

  const getSnapshot = useCallback((): QueryStringValue | undefined => {
    return readQueryStringValue(key, cache);
  }, [key]);

  const subscribe = useCallback((onStoreChange: () => void): (() => void) => {
    return routerEvents.onNavigated(onStoreChange);
  }, []);

  // The same function for both arguments: `readQueryStringValue` already
  // branches on `currentSearch()`'s own `typeof window` check, so there is no
  // separate server answer to compute — passing it twice is what tells React
  // the hydration render and the server render must agree.
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
