/**
 * `localizedPath(path, locale?)`: the in-app path for `path` in `locale`
 * under the active locale routing (`web.localeRouting.strategy`). Used for
 * links built by hand, such as a page's `metadata.canonical`, so a `/ar/...`
 * page points at its own URL rather than the default locale's.
 *
 * `locale` defaults to the current request's locale on the server (and the
 * active locale in the browser). With strategy `none`, or for the default
 * locale under `prefix-except-default`, the path comes back unchanged.
 */
import { readCurrentLocale } from "./current-locale";
import { withLocalePrefix } from "./locale-prefixed-paths";
import { isPrefixedLocale, readLocaleRouting } from "./locale-routing";

export function localizedPath(path: string, locale?: string): string {
  const routing = readLocaleRouting();
  const code = locale ?? readCurrentLocale();

  if (code === undefined || !isPrefixedLocale(routing, code)) return path;

  return withLocalePrefix(path, code);
}
