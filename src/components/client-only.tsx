import type { ReactNode } from "react";
import { useIsClient } from "./use-is-client";

/**
 * Children as a plain node, or as a function invoked only once this render is
 * happening in the browser. The function form exists for code that touches
 * `window`/`document` AT RENDER TIME — a plain node is already constructed by
 * the time it reaches `<ClientOnly>` and cannot defer that.
 */
export type ClientOnlyChildren = ReactNode | (() => ReactNode);

export type ClientOnlyProps = {
  /** What renders once this is running in the browser and past hydration. */
  children: ClientOnlyChildren;
  /**
   * What renders on the server AND during the hydration render — the two
   * passes React requires to produce IDENTICAL output. Defaults to `null`.
   */
  fallback?: ReactNode;
};

/**
 * Renders `fallback` on the server and during hydration, then swaps to
 * `children` once mounted — with no hydration mismatch, because the swap
 * happens on a render React triggers AFTER comparing against the server
 * markup, never during it (see {@link useIsClient}).
 *
 * This defers RENDERING only, not MODULE LOADING. A module with top-level
 * `window` access still runs on the SERVER when it is imported normally,
 * because ordinary `import` statements execute at module-load time regardless
 * of where in the tree the imported thing ends up rendered:
 *
 * ```tsx
 * import BrowserOnlyWidget from "./browser-only-widget"; // runs on the server too
 *
 * <ClientOnly>
 *   <BrowserOnlyWidget /> // too late: the import already ran
 * </ClientOnly>
 * ```
 *
 * To defer the IMPORT itself, make it lazy with `React.lazy`, so the dynamic
 * `import()` only fires when the lazy component is actually rendered — which,
 * inside `<ClientOnly>`, is never on the server:
 *
 * ```tsx
 * import { lazy } from "react";
 *
 * const BrowserOnlyWidget = lazy(() => import("./browser-only-widget"));
 *
 * <ClientOnly fallback={<Placeholder />}>
 *   <BrowserOnlyWidget />
 * </ClientOnly>
 * ```
 *
 * @example
 * ```tsx
 * <ClientOnly fallback={<p>Loading map…</p>}>
 *   {() => <Map center={window.localStorage.getItem("lastCenter")} />}
 * </ClientOnly>
 * ```
 */
export function ClientOnly({ children, fallback = null }: ClientOnlyProps): ReactNode {
  const isClient = useIsClient();

  if (!isClient) return fallback;

  return typeof children === "function" ? children() : children;
}
