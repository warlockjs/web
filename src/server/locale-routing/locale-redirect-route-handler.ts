/**
 * Redirect handlers the installers register in place of a base page route,
 * under an active `web.localeRouting.strategy` (design note §A.3-4):
 *
 * - `prefix-except-default`: `/<default>/<path>` answers 301 → `/<path>`
 *   (the default locale is deterministic and unprefixed).
 * - `prefix`: the unprefixed `/<path>` answers 302 → `/<resolved>/<path>`,
 *   where the locale is resolved the ordinary query→cookie→header way
 *   (`request.locale`, `core/src/http/request.ts`).
 *
 * BUG FIXED: both handlers used to build the Location from the route
 * PATTERN (`effectivePath`, e.g. `/posts/:slug`) handed to
 * `../locale-page-registrations.ts`, not the request's actual matched path —
 * so `/en/posts/hello` redirected to the literal `/posts/:slug`. They now
 * read `request.path` (Fastify's raw `url`, which is `pathname` plus `?query`
 * verbatim — never re-derived from `request.query`, which drops arrays and
 * nested values) and strip/prefix that instead.
 *
 * Shared by both installers (`../install-page-routes.ts`,
 * `../install-page-routes-from-manifest.ts`) so dev and production redirect
 * identically — no duplicated logic.
 */
import type { HttpContext } from "@warlock.js/core";
import { withLocalePrefix } from "../../routing/locale-prefixed-paths";
import type { PageRouteHandler } from "../create-page-route-handler";

/**
 * Splits Fastify's raw `request.path` (`pathname` + `?search`, verbatim —
 * unlike `request.query`, nothing here is parsed or re-serialized) into its
 * two halves. `search` excludes the leading `?`.
 */
function splitPathAndQuery(rawPath: string): { pathname: string; search: string } {
  const queryIndex = rawPath.indexOf("?");

  return queryIndex === -1
    ? { pathname: rawPath, search: "" }
    : { pathname: rawPath.slice(0, queryIndex), search: rawPath.slice(queryIndex + 1) };
}

/**
 * Open-redirect guard: a Location starting with `//` (or `/\`, which some
 * browsers also treat as scheme-relative) is read as a scheme-relative URL —
 * `//evil.com` redirects OFF this origin. Collapsing any run of leading
 * slashes/backslashes to one keeps the Location an ordinary same-origin path
 * no matter what a stripped/prefixed segment produces.
 */
function sameOriginPath(path: string): string {
  const collapsed = path.replace(/^[/\\]+/, "/");

  return collapsed.length > 0 ? collapsed : "/";
}

/** Re-attaches `search` (already `?`-free, already verbatim) onto `target`. */
function withQueryString(target: string, search: string): string {
  return search.length > 0 ? `${target}?${search}` : target;
}

/**
 * Strips a leading `/<defaultLocale>` segment from `pathname` — `/en/posts`
 * → `/posts`, `/en` (the root) → `/`. A `pathname` that does not carry the
 * prefix (should not happen — this handler is only ever registered at
 * `/<defaultLocale>/...`) is returned unchanged rather than mangled.
 */
function stripDefaultLocalePrefix(pathname: string, defaultLocale: string): string {
  const prefix = `/${defaultLocale}`;

  if (pathname === prefix) return "/";
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);

  return pathname;
}

/**
 * Builds the `/<default>/<path>` → `/<path>` 301 handler for
 * `prefix-except-default`. Takes the DEFAULT LOCALE CODE, not a path
 * pattern — the target is derived from the request's own matched pathname,
 * so a dynamic segment (`/en/posts/hello`) redirects to its own resolved
 * path (`/posts/hello`), never to the route's `:slug` pattern.
 */
export function defaultLocaleRedirectHandler(defaultLocale: string): PageRouteHandler {
  return async ({ request, response }: HttpContext) => {
    const { pathname, search } = splitPathAndQuery(request.path);
    const target = sameOriginPath(stripDefaultLocalePrefix(pathname, defaultLocale));

    return response.permanentRedirect(withQueryString(target, search));
  };
}

/**
 * Builds the `/<path>` → `/<resolved>/<path>` 302 handler for `prefix`. The
 * locale is resolved by `request.locale` itself — this handler runs BEFORE
 * anything pins it, so the ordinary query→cookie→header order applies. The
 * target is built from the request's own matched pathname, for the same
 * reason `defaultLocaleRedirectHandler` is.
 */
export function resolvedLocaleRedirectHandler(): PageRouteHandler {
  return async ({ request, response }: HttpContext) => {
    const { pathname, search } = splitPathAndQuery(request.path);
    const target = sameOriginPath(withLocalePrefix(pathname, request.locale));

    return response.redirect(withQueryString(target, search));
  };
}
