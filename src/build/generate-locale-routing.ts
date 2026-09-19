/**
 * The CLIENT half of the locale-routing config handoff: the source of the
 * `localeRouting` export the client page registry virtual module carries
 * into the browser, beside `pages` — mirrors `generate-client-registry.ts`
 * in shape and purpose.
 *
 * Design: releases/v5.17-locale-routing-design-note.md §B.1/§B.4 — "the
 * client learns the strategy, codes and default from the published route
 * table, not a new hydration key." This is that publication's SOURCE half;
 * `publishLocaleRouting` (`../routing/locale-routing.ts`), called from the
 * hydration entry, is the sink.
 *
 * Pure: reads nothing, writes nothing, just serializes the {@link
 * LocaleRouting} value the caller resolved — `page-registry-plugin.ts` is
 * the one place that resolves it (via `resolveLocaleRouting`, the same
 * function the server installers use) and calls this.
 */
import type { LocaleRouting } from "../routing/locale-routing";

/** The name of the value the generated module exports. */
export const CLIENT_LOCALE_ROUTING_EXPORT_NAME = "localeRouting";

/** The specifier the emitted module imports its type from. */
const LOCALE_ROUTING_TYPE_SPECIFIER = "@warlock.js/web/client/runtime";

function quote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Returns the SOURCE of the `localeRouting` export — appended to
 * `generateClientRegistry`'s own output before both are handed to
 * `eraseTypes` together, so the two share one erasure pass.
 */
export function generateLocaleRoutingSource(routing: LocaleRouting): string {
  const codes = routing.codes.map((code) => quote(code)).join(", ");

  return [
    `import type { LocaleRouting } from ${quote(LOCALE_ROUTING_TYPE_SPECIFIER)};`,
    "",
    `export const ${CLIENT_LOCALE_ROUTING_EXPORT_NAME}: LocaleRouting = {`,
    `  strategy: ${quote(routing.strategy)},`,
    `  codes: [${codes}],`,
    `  defaultLocale: ${quote(routing.defaultLocale)},`,
    "};",
    "",
  ].join("\n");
}
