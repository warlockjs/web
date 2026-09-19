/**
 * The single source of truth for the document-boundary meta tag name the
 * release-blocker fix carries the runtime `LocaleRouting` table across:
 * `<Head/>` (`components/head.ts`) writes it, `entry/publish-document-locale-routing.ts`
 * reads it. One constant, one file, so the writer and reader cannot drift
 * apart under a rename.
 */
export const LOCALE_ROUTING_META_NAME = "warlock-locale-routing";
