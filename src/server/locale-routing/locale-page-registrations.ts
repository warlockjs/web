/**
 * The full set of router registrations ONE page needs under
 * `web.localeRouting.strategy` — the base registration (possibly rewritten)
 * plus every prefixed/redirect registration the design note describes
 * (§A.2-4) — OR, when the page carries its own leading `:locale` param
 * (design note §C), the single `[locale]`-wrapped registration instead. Pure:
 * both installers (`../install-page-routes.ts`,
 * `../install-page-routes-from-manifest.ts`) call this with the page's own
 * `effectivePath`, name and handler, then register whatever it returns
 * through their own `router.get` — the only thing that differs between them
 * (dev additionally wraps each call in `router.withSourceFile`).
 */
import type { LocaleRouting } from "../../routing/locale-routing";
import { localePrefixedPaths, withLocalePrefix } from "../../routing/locale-prefixed-paths";
import type { PageRouteHandler } from "../create-page-route-handler";
import {
  defaultLocaleRedirectHandler,
  resolvedLocaleRedirectHandler,
} from "./locale-redirect-route-handler";
import { localePrefixedPageHandler } from "./locale-prefixed-page-handler";
import { hasLeadingLocaleParam, localeParamPageHandler } from "./locale-param-page-handler";
import { LocaleParamRoutingConflictError } from "./locale-param-routing-conflict";

export type LocalePageRegistration = {
  path: string;
  handler: PageRouteHandler;
  /** Set only on the base registration — `../../routing/locale-routing.ts`'s own rule. */
  name: string | undefined;
};

/**
 * Everything `localePageRegistrations` needs about the page's OWN identity —
 * separate from `routing`, which is the process-wide config the page's
 * identity is checked against.
 */
export type LocalePageRegistrationContext = {
  /** The page's source file, named in {@link LocaleParamRoutingConflictError}. */
  pageFile: string;
  /**
   * The not-found handler a `[locale]`-routed page's bad `:locale` value
   * renders — the exact getter both installers already pass through to
   * `createPageRouteHandler` as `renderNotFound`, so a bad locale and a
   * loader `notFound()` answer with the identical document.
   */
  renderNotFound: () => PageRouteHandler | undefined;
};

/**
 * Builds every registration `effectivePath` needs, in order:
 *
 * - a page with its own leading `:locale` param (§C) gets exactly one
 *   registration, wrapped by {@link localeParamPageHandler} — config-free,
 *   and refused at boot ({@link LocaleParamRoutingConflictError}) when
 *   `routing.strategy` is also active, since the two would double-prefix.
 * - otherwise, under `"none"`, the one base registration, unchanged — the
 *   innocent case.
 * - otherwise, the base registration first (rewritten under
 *   `prefix-except-default` and `prefix`), then the extra locale
 *   registrations (§A.2-4).
 */
export function localePageRegistrations(
  effectivePath: string,
  name: string,
  handler: PageRouteHandler,
  routing: LocaleRouting,
  context: LocalePageRegistrationContext,
): LocalePageRegistration[] {
  if (hasLeadingLocaleParam(effectivePath)) {
    if (routing.strategy !== "none") {
      throw new LocaleParamRoutingConflictError(context.pageFile, routing.strategy);
    }

    return [
      {
        path: effectivePath,
        handler: localeParamPageHandler(handler, routing.codes, context.renderNotFound),
        name,
      },
    ];
  }

  if (routing.strategy === "none") {
    return [{ path: effectivePath, handler, name }];
  }

  const registrations: LocalePageRegistration[] = [];

  if (routing.strategy === "prefix-except-default") {
    // The default locale is served deterministically at the bare path — the
    // cookie/header/query are ignored, for SEO (design note §A.3).
    registrations.push({
      path: effectivePath,
      handler: localePrefixedPageHandler(handler, routing.defaultLocale),
      name,
    });
    // `/<default>/<path>` answers 301 → `/<path>`. Built from the REQUEST's
    // own matched pathname, not this route pattern — `../locale-redirect-route-handler.ts`.
    registrations.push({
      path: withLocalePrefix(effectivePath, routing.defaultLocale),
      handler: defaultLocaleRedirectHandler(routing.defaultLocale),
      name: undefined,
    });
  } else {
    // `"prefix"`: the bare path is a 302 to the query→cookie→header-resolved
    // locale, prefixed onto the REQUEST's own matched pathname.
    registrations.push({
      path: effectivePath,
      handler: resolvedLocaleRedirectHandler(),
      name,
    });
  }

  for (const { path, locale } of localePrefixedPaths(effectivePath, routing)) {
    registrations.push({
      path,
      handler: localePrefixedPageHandler(handler, locale),
      name: undefined,
    });
  }

  return registrations;
}
