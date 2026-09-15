/**
 * The POLICY half of scroll restoration: what to do with the scroll bar for a
 * given navigation, and the handful of DOM primitives that policy needs.
 *
 * `navigation-root.tsx` owns WHEN — it knows a navigation is a push, a
 * replace, or a Back/Forward, and it knows the one instant a swapped page is
 * actually in the DOM (its `useLayoutEffect`, already used for fragment
 * scrolling). This module owns WHAT: given that moment has arrived, plus the
 * URL's hash and whatever `scroll-positions.ts` has on file for the entry
 * being left or returned to, decide once and act.
 *
 * Kept as pure decisions (`decideNewNavigationScroll`,
 * `decidePopStateScroll`) rather than functions that reach into `window`
 * themselves, so the rule "a saved position beats a hash on Back/Forward" is
 * provable without mounting anything.
 */
import { getScrollPosition, saveScrollPosition, type ScrollPosition } from "./scroll-positions";

/** What the router should do with the scroll bar once the new page is on screen. */
export type ScrollDecision =
  | { readonly type: "restore"; readonly position: ScrollPosition }
  | { readonly type: "fragment"; readonly fragment: string }
  | { readonly type: "top" };

/**
 * A `<Link>` click or `navigateTo()` — always a page the user is arriving at
 * for the first time in this entry, so there is never a saved position to
 * weigh against the URL's hash: the hash wins outright when present, exactly
 * as a full page load would land on it.
 */
export function decideNewNavigationScroll(hash: string | undefined): ScrollDecision {
  return hash !== undefined ? { type: "fragment", fragment: hash } : { type: "top" };
}

/**
 * Back/Forward. The saved position for the entry being RETURNED to wins over
 * its hash, deliberately: a hash names where the user first arrived, and a
 * saved position names where they had since scrolled to — the latter is what
 * "go back" means. Falling back to the hash, then to the top, only when
 * nothing was ever saved for this entry — a session that never visited it in
 * this tab, or one `sessionStorage` could not restore.
 */
export function decidePopStateScroll(key: string, hash: string | undefined): ScrollDecision {
  const saved = getScrollPosition(key);

  if (saved !== undefined) return { type: "restore", position: saved };

  return decideNewNavigationScroll(hash);
}

/** The one `History` surface this module needs — real, or a test double. */
export type ScrollRestorationHistory = {
  scrollRestoration: ScrollRestoration;
};

let manualRestorationInstalled = false;

/**
 * `history.scrollRestoration = "manual"`, once. Called at the client router's
 * boot (`navigation-root.tsx`'s mount effect) — from this point on the
 * browser stops moving the scroll bar on Back/Forward on its own, which is
 * what makes this module's own restoration the only thing doing it and
 * therefore able to do it AFTER the swapped page has rendered rather than
 * before.
 *
 * Wrapped in `try`/`catch`: the property is unsupported in a handful of older
 * engines, and failing to set a preference must not cost the navigation that
 * is asking for it.
 */
export function installManualScrollRestoration(history: ScrollRestorationHistory): void {
  if (manualRestorationInstalled) return;

  manualRestorationInstalled = true;

  try {
    history.scrollRestoration = "manual";
  } catch {
    // Unsupported — Back/Forward falls back to whatever the browser does on
    // its own, which is the behaviour this feature is additive to.
  }
}

/** For tests: forget that manual restoration was already installed. */
export function resetManualScrollRestorationInstalled(): void {
  manualRestorationInstalled = false;
}

/** Save the CURRENT scroll position under `key` — called before leaving an entry. */
export function captureScrollPosition(key: string): void {
  saveScrollPosition(key, { x: window.scrollX, y: window.scrollY });
}

/** Move the scroll bar to the top of the document. */
export function scrollToTop(): void {
  window.scrollTo(0, 0);
}

/** Move the scroll bar to a previously saved position. */
export function applyScrollPosition(position: ScrollPosition): void {
  window.scrollTo(position.x, position.y);
}
