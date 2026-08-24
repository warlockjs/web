import { currentNavigator } from "../../routing/navigator";

/**
 * The history verbs, under the names MRR spells them
 * (`@mongez/react-router` — `src/utilities.tsx`).
 *
 * A developer moving between a Mongez CSR app and a Warlock SSR app should not
 * relearn "go there" and "go back", so the names and call shapes are MRR's.
 * What is NOT MRR's is the mechanism: MRR's `navigateTo` reaches its router
 * singleton, and that singleton is the client-side matcher Warlock
 * deliberately does not have — the SERVER router is the only matcher
 * (canon `9c8f878b`). So `navigateTo` here delegates to the navigator the
 * client runtime registered, and knows nothing about paths beyond passing one
 * along.
 *
 * ## Why nothing in this file throws
 *
 * All three are importable from universal modules, which means all three can
 * be CALLED with no browser and no runtime: during the server render, and in
 * the gap between first paint and hydration. Each therefore has a defined
 * "did nothing" answer — `false`, a no-op, `""` — instead of an exception.
 * Throwing here would cost the page rather than the navigation.
 */

/**
 * Navigate to a path client-side.
 *
 * @param path where to go — passed through untouched; matching is the server's
 * job, so this is not parsed, resolved or prefixed here.
 * @param options `replace: true` swaps the current history entry instead of
 * pushing a new one, so Back skips it.
 * @returns `true` if the client runtime accepted the navigation. `false` means
 * nothing handled it — either no runtime is connected yet (server render, or
 * pre-hydration) or the runtime declined the URL. A `false` caller that needs
 * the user to arrive anyway should fall back to a real browser navigation.
 */
export function navigateTo(path: string, options?: { replace?: boolean }): boolean {
  const navigator = currentNavigator();

  if (!navigator) return false;

  return navigator(path, options);
}

/**
 * Go back one entry in browser history.
 *
 * This is the browser's own Back, not a re-navigation to a remembered URL, so
 * it restores scroll and forward history the way the button does. No-op
 * without a `window`.
 */
export function navigateBack(): void {
  if (typeof window === "undefined") return;

  window.history.back();
}

/**
 * @returns the current url's hash WITHOUT its leading `#` — MRR's shape, so
 * `getHash() === "reviews"` for `/products#reviews`. `""` when there is no
 * hash, and `""` rather than `undefined` when there is no `window`, so callers
 * can treat the result as a string unconditionally.
 */
export function getHash(): string {
  if (typeof window === "undefined") return "";

  return window.location.hash.replace("#", "");
}
