/**
 * Parses and validates the SERVER document's `<meta name="warlock-locale-routing"
 * content='{"strategy":..,"codes":[..],"defaultLocale":".."}'>` (rendered by
 * `<Head/>`, `components/head.ts`, from `DocumentContextValue.localeRouting`)
 * back into a {@link LocaleRouting} value.
 *
 * Deliberately a pure string-in, value-or-`undefined`-out function — no DOM
 * read here, so it is trivial to unit test every malformed shape without a
 * document. `publish-document-locale-routing.ts` owns reading the meta tag
 * itself and falling back to the build-time value when this returns
 * `undefined`.
 *
 * ANYTHING that doesn't match the exact runtime shape returns `undefined`
 * rather than throwing or guessing a partial value — a malformed or missing
 * meta tag must fall back to `virtual:warlock/pages`'s build-time table, not
 * crash hydration or publish a half-valid routing table.
 */
import type { LocaleRouting, LocaleRoutingStrategy } from "../routing/locale-routing";

const VALID_STRATEGIES: readonly LocaleRoutingStrategy[] = [
  "none",
  "prefix",
  "prefix-except-default",
];

function isValidStrategy(value: unknown): value is LocaleRoutingStrategy {
  return typeof value === "string" && (VALID_STRATEGIES as readonly string[]).includes(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Valid, well-formed JSON → the `LocaleRouting` value. Anything else → `undefined`. */
export function parseLocaleRoutingMeta(
  content: string | null | undefined,
): LocaleRouting | undefined {
  if (!content) return undefined;

  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;

  const { strategy, codes, defaultLocale } = parsed as Record<string, unknown>;

  if (!isValidStrategy(strategy)) return undefined;
  if (!isStringArray(codes)) return undefined;
  if (typeof defaultLocale !== "string") return undefined;

  return { strategy, codes, defaultLocale };
}
