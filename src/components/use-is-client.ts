import { useSyncExternalStore } from "react";

/**
 * Flips once, after the first client commit, and stays `true` for the life of
 * the page: hydration is over for every later mount (a client navigation), so
 * those mounts must not replay the server snapshot.
 */
let hydrated = false;

function subscribe(onChange: () => void): () => void {
  // Subscribing happens in the commit phase, after hydration has matched.
  if (!hydrated) {
    hydrated = true;
    onChange();
  }

  return () => undefined;
}

const getClientSnapshot = (): boolean => hydrated;
const getServerSnapshot = (): boolean => false;

/**
 * Whether this render is happening in the browser, after hydration.
 *
 * `false` on the server AND during the render that hydrates the
 * server-rendered markup (React uses the server snapshot there, so the two
 * cannot disagree); `true` afterwards. Backed by a module-level flag rather
 * than per-mount state, so a component mounted by a later client navigation
 * gets `true` on its first render and does not flash its fallback for a frame.
 *
 * See `<ClientOnly>` ({@link "./client-only"}) for the common case — most
 * call sites want fallback/children switching, not the raw boolean.
 *
 * @example
 * ```tsx
 * function ThemeToggle() {
 *   const isClient = useIsClient();
 *   return <button disabled={!isClient}>Toggle theme</button>;
 * }
 * ```
 */
export function useIsClient(): boolean {
  return useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
}
