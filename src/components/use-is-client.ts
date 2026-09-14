import { useEffect, useState } from "react";

/**
 * Whether this render is happening in the browser, after mount.
 *
 * `false` on the server AND during the render that hydrates the
 * server-rendered markup; `true` from the next render onward, once mounted.
 *
 * Deliberately built on `useState` + `useEffect` rather than
 * `useSyncExternalStore`: the initial state is the constant `false`, so the
 * FIRST render always returns it — on the server, and again on the client's
 * hydration pass — with no `typeof window` branch that the two environments
 * could evaluate differently. `useEffect` never runs during server rendering
 * and never runs during the render React reconciles against the server HTML,
 * so the flip to `true` can only happen after hydration has already matched;
 * there is no window where this hook's return value could disagree with what
 * was sent down the wire.
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
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  return isClient;
}
