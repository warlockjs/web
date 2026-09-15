import { useLocale } from "./localization";
import { localeDirection, type TextDirection } from "./text-direction";

/**
 * Read the current request/page locale — the same accessor `useLocale()`
 * exposes to server render and client alike — and resolve its text
 * direction. No hydration payload change is involved: the direction is
 * derived, never carried over the wire.
 */
export function useTextDirection(): TextDirection {
  const locale = useLocale();

  return localeDirection(locale);
}
