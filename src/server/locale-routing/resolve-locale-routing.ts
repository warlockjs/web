/**
 * Reads `web.localeRouting` and folds in the app's locale configuration —
 * codes from `app.localeCodes`, the default from `app.localeCode` — into a
 * {@link LocaleRouting} value both installers publish and register against.
 *
 * There is deliberately no second locale list here (design note §Config):
 * `web.localeRouting` carries only the strategy, mirroring how
 * `../../sitemap/resolve-sitemap-config.ts` folds `app.localeCode(s)` into
 * its own resolved shape.
 */
import { config } from "@warlock.js/core";
import { type LocaleRouting, type LocaleRoutingStrategy } from "../../routing/locale-routing";

const STRATEGIES: readonly LocaleRoutingStrategy[] = ["none", "prefix", "prefix-except-default"];

/** Raised at boot when `web.localeRouting` is misconfigured. */
export class LocaleRoutingConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LocaleRoutingConfigError";
  }
}

function isLocaleRoutingStrategy(value: unknown): value is LocaleRoutingStrategy {
  return typeof value === "string" && (STRATEGIES as readonly string[]).includes(value);
}

/** The strategy-only shape accepted from either `web.localeRouting` or one site. */
export type LocaleRoutingConfig = { readonly strategy?: LocaleRoutingStrategy };

/**
 * Resolves `web.localeRouting.strategy` (default `"none"`) against
 * `app.localeCodes` / `app.localeCode`, throwing a clear config error rather
 * than booting with a routing table nothing can satisfy.
 */
export function resolveLocaleRouting(localeRoutingConfig?: LocaleRoutingConfig): LocaleRouting {
  // An explicitly configured site (including `{}`) replaces the global
  // strategy; absence is the only case that inherits `web.localeRouting`.
  const effectiveConfig = localeRoutingConfig ?? config.get("web", {}).localeRouting;
  const strategy = effectiveConfig?.strategy ?? "none";

  if (!isLocaleRoutingStrategy(strategy)) {
    throw new LocaleRoutingConfigError(
      `web.localeRouting.strategy is "${String(strategy)}", which is not a valid strategy. ` +
        `Use one of: ${STRATEGIES.map((value) => `"${value}"`).join(", ")}.`,
    );
  }

  const codes = config.key<string[]>("app.localeCodes", []) ?? [];
  const defaultLocale = config.key<string>("app.localeCode", "") ?? "";

  if (strategy !== "none") {
    if (codes.length < 1) {
      throw new LocaleRoutingConfigError(
        `web.localeRouting.strategy is "${strategy}" but app.localeCodes declares no locale ` +
          "codes. Configure at least one code in app.localeCodes before enabling locale routing.",
      );
    }

    if (!codes.includes(defaultLocale)) {
      throw new LocaleRoutingConfigError(
        `web.localeRouting.strategy is "${strategy}" but app.localeCode ("${defaultLocale}") is ` +
          `not one of app.localeCodes (${codes.map((code) => `"${code}"`).join(", ")}).`,
      );
    }
  }

  return { strategy, codes, defaultLocale };
}
