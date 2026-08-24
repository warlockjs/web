/**
 * The one seam between `<Link>` and the client navigation runtime.
 *
 * `<Link>` is UNIVERSAL — the same component renders on the server and in the
 * browser — so it cannot import the runtime: doing so would drag `fetch`, the
 * page registry and React state into the server render, and into the bundle of
 * any app that never navigates client-side.
 *
 * So the runtime REGISTERS itself here instead, and `<Link>` asks. On the
 * server nothing has registered, `currentNavigator()` is `undefined`, and the
 * anchor behaves as a plain anchor — which is exactly right, because on the
 * server it IS a plain anchor.
 *
 * This is also what makes the feature progressively enhancing rather than
 * load-bearing: until the hydration bundle has run and registered, every link
 * on the page still works as an ordinary link.
 */

/**
 * @returns `true` if the runtime accepted the navigation and the caller should
 * suppress the browser's default. `false` means "not mine" — let the browser do
 * what it was going to do.
 */
export type Navigator = (url: string, options?: { replace?: boolean }) => boolean;

let navigator: Navigator | undefined;

/**
 * Installed by the navigation runtime at mount, and torn down with `undefined`.
 *
 * @returns the previous navigator, so a caller that installs one can restore
 * what was there — the same shape the other `connect*` seams in this package
 * use, and what makes a test able to leave the module as it found it.
 */
export function connectNavigator(next: Navigator | undefined): Navigator | undefined {
  const previous = navigator;

  navigator = next;

  return previous;
}

export function currentNavigator(): Navigator | undefined {
  return navigator;
}
