/**
 * The entry-side sink for the release-blocker fix: reads the SERVER
 * document's `warlock-locale-routing` meta tag (rendered by `<Head/>`,
 * `components/head.ts`, from `DocumentContextValue.localeRouting`,
 * `server/render-page.ts`) and publishes it as the browser's runtime
 * locale-routing table.
 *
 * `fallback` — the build-time `virtual:warlock/pages` `localeRouting` export
 * (`vite/page-registry-plugin.ts` + `build/generate-locale-routing.ts`) — is
 * used ONLY when the meta is absent or malformed. The build-time value can be
 * wrong (app config not loaded at build time, or differing per environment),
 * so the runtime value the server actually resolved for THIS request always
 * wins when it is present and valid.
 *
 * A tiny, standalone function on purpose: `entry/index.ts` calls it once,
 * before mount, and this is the seam a unit test drives instead of the whole
 * entry module (which also touches the route table and hydration).
 */
import { publishLocaleRouting, type LocaleRouting } from "../routing/locale-routing";
import { LOCALE_ROUTING_META_NAME } from "../routing/locale-routing-meta-name";
import { parseLocaleRoutingMeta } from "./parse-locale-routing-meta";

export function publishDocumentLocaleRouting(fallback: LocaleRouting): void {
  const meta = document.querySelector(`meta[name="${LOCALE_ROUTING_META_NAME}"]`);
  const parsed = parseLocaleRoutingMeta(meta?.getAttribute("content"));

  publishLocaleRouting(parsed ?? fallback);
}
