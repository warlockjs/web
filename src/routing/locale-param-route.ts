/**
 * The one predicate for `[locale]`-folder routing (design note §C): is a
 * route path's FIRST segment the param `:locale`, as in a `src/web/[locale]/...`
 * page or an explicit `/:locale/...` route? Universal: the server installers
 * (`../server/locale-routing/locale-page-registrations.ts`), `<Link>` and
 * `changeLocaleCode` all use this one copy.
 */
export const LOCALE_PARAM_NAME = "locale";

/**
 * A `:locale` appearing deeper in the path (`/posts/:locale`) is an ordinary
 * param and does not count — only the FIRST segment does.
 */
export function hasLeadingLocaleParam(path: string): boolean {
  const [firstSegment] = path.split("/").filter((segment) => segment.length > 0);

  return firstSegment === `:${LOCALE_PARAM_NAME}`;
}
