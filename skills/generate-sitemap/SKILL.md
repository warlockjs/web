---
name: generate-sitemap
description: 'Serve `/sitemap.xml` and `/robots.txt` from a Warlock web app with the `@warlock.js/web/sitemap` subpath — the `web.sitemap` and `web.robots` keys in `src/config/web.ts`, page `config.sitemap` (opt out, static options, or a supplier for dynamic routes), locale/hreflang expansion, the automatic switch to a sharded `SitemapIndex`, when generation runs (intervals, committed model changes, runtime boot or `regenerateSitemap()` — never `warlock build`), the 503-before-first-generation rule, and `MissingPublicUrlError`. Triggers: `web.sitemap`, `web.robots`, `WebSitemapConfig`, `RobotsConfig`, `SitemapPageExport`, `export const sitemap`, `regenerateSitemap`, `generateSitemap`, `MissingPublicUrlError`, `splitByLocale`, `localeUrl`, `referenceSitemap`, `warlock add sitemap`; "add a sitemap to my Warlock site", "dynamic route missing from sitemap.xml", "regenerate the sitemap after publishing a post", "robots.txt", "sitemap returns 503", "hreflang in the sitemap". Skip: the framework-blind builder classes themselves (`Sitemap`, `SitemapIndex`, Express/cron usage) — `@warlock.js/sitemap/sitemap-overview/SKILL.md`; `app.publicUrl` — `@warlock.js/core/configure-app/SKILL.md`; page metadata `robots: noindex` — `@warlock.js/web/create-a-page/SKILL.md`; competing tools `next-sitemap`, `sitemap` npm package direct.'
---

# Generate a sitemap and robots.txt

Web discovers the page graph and serves persisted XML. Enable sitemap generation
under `web.sitemap`, and set `app.publicUrl` (or `PUBLIC_APP_URL`). The origin
is never inferred from a request header. `warlock add sitemap` installs the
sitemap package and adds disabled configuration; enable it explicitly.

```ts
import type { WebConfigurations } from "@warlock.js/web";

export default {
  sitemap: {
    enabled: true,
    storage: { directory: "sitemaps" },
    regenerateEvery: "1d",
  },
  robots: {
    enabled: true,
    groups: [{ userAgent: "*", disallow: ["/admin"] }],
  },
} satisfies WebConfigurations;
```

`storage.disk` selects a configured Core storage name; omission uses the app's
default storage. `storage.directory` defaults to `"sitemap"` and must be a
dedicated relative prefix. The legacy `outputDir` option still selects a local
directory. Do not combine it with `storage`.

## Page policy and dynamic URLs

Static routable pages are included by default. Error pages are excluded.
`config.sitemap: false` opts out. A page or layout may supply static options
such as `priority`, `changefreq`, `lastmod`, `locales: false`, or
`localePaths`. The nearest explicit page/layout policy wins; layout policies
cannot supply dynamic entries.

A route such as `/products/:slug` is a pattern, not a URL. Give that page a
supplier returning its concrete URLs. Warlock does not crawl links or infer a
model query. Without a supplier the dynamic route contributes zero URLs and
appears with a zero count in generation diagnostics.

```ts
import type { PageConfig } from "@warlock.js/web";
import { Product } from "./product.server";
import { listPublishedProductSitemapRows } from "./product-sitemap-data.server";

async function productSitemap() {
  const products = await listPublishedProductSitemapRows();
  return products.map(product => ({
    path: `/products/${encodeURIComponent(product.slug)}`,
    lastmod: product.updatedAt,
    images: [{ loc: product.imageUrl }],
  }));
}

export const config: PageConfig = {
  sitemap: {
    entries: productSitemap,
    invalidateOn: [Product],
  },
};
```

The query helper above is application-owned: select eligible published rows.
A plain `sitemap: productSitemap` function remains supported. The object form
adds `invalidateOn` and static defaults, including `locales: false` for every
supplied entry. Supplier functions return an Iterable or Promise of an Iterable;
the Web adapter currently materializes entries in memory.

Sitemap configuration and its exclusive model imports are projected out of the
browser graph. Keep models in server modules and do not read them from the page
component or client `register` function.

Images use the image sitemap extension, with at most 1,000 images per URL;
excess images are dropped with a warning per route. Price, stock and product
description belong in page structured data or a product feed, not sitemap XML.

## Refreshing after changes

The application-level function is:

```ts
import { regenerateSitemap } from "@warlock.js/web/sitemap";

// After the application's transaction has successfully committed:
await regenerateSitemap();
```

For an import, call it once after the batch commits. A request made during a
generation waits for a following pass; concurrent requests may share that pass.
Later requests can require another pass. A failed pass rejects its callers and
keeps the last published sitemap.

`invalidateOn` subscribes to the declared models' saved/deleted events and uses
Cascade's `afterCommit` hook before marking the sitemap stale. It debounces
events for 30 seconds of quiet, with a five-minute maximum wait. Cascade is
optional unless this feature is used. Listeners are removed on reload/shutdown.
Bulk writes, raw SQL and external writers may bypass model events, so use
explicit regeneration or the interval safety net.

`regenerateEvery` is optional; omission means no interval. It accepts positive
milliseconds or durations such as `"30s"`, `"6h"`, and `"1d"`. Timers do
not keep the process alive and are cleared on shutdown/reload. They use the
same generation coordinator, retain the last good output on failure, and retry
on a later tick. `changefreq` is crawler metadata, not a refresh schedule.

`generateSitemap()` remains a low-level one-shot artifact writer. It does not
update the managed HTTP serving state or coordinate refreshes. Use
`regenerateSitemap()` for application changes.

## Storage, restarts and multiple instances

Managed generations contain immutable files plus a manifest. Startup validates
and restores the latest valid manifest, then refreshes in the background when
`regenerate.onBoot` is enabled (default true). With no valid manifest,
`/sitemap.xml` returns 503 and `Retry-After: 30` until generation succeeds.
Requests only serve published artifacts; they never trigger generation.
`warlock build` does not generate the sitemap.

`coordination: "local"` is the default for one process. For multiple servers:

```ts
sitemap: {
  enabled: true,
  coordination: "shared",
  storage: { disk: "assets", directory: "sitemaps" },
  regenerateEvery: "1d",
}
```

Here `assets` must already be a configured shared storage disk. Shared mode
requires atomic create-if-absent and consistent reads/listing. Supported
conditional-write providers are S3 and R2; local storage requires a genuinely
shared filesystem with the corresponding guarantees. Do not assume every
S3-compatible provider supports the capability. There is no built-in GCS
driver, and Spaces conditional creation is not currently supported.

Each pass claims a durable increasing number before collecting entries. The
highest valid manifest determines the served generation. No Redis is required.
Concurrent servers can duplicate generation work; publication order remains
defined by their claims. Claims are retained so numbers cannot be reused.
Other instances refresh manifest metadata at most every `manifestPollMs`
(default 30,000). A manual caller awaits its own server's post-request pass.

## Locales, shards and HTTP caching

Locale codes/defaults come from `app.localeCodes` and `app.localeCode`,
unless overridden under `sitemap.locales`. Each URL expands once per configured
locale with hreflang alternates. Active locale routing determines prefixed
URLs; `localeUrl` overrides that convention and a page's `localePaths` wins.

Above 50,000 collected entries, or with `locales.splitByLocale`, the main
endpoint serves an index. Shards use generation-specific URLs under
`/sitemaps/<generationId>/`. Retention keeps recent generations for old index
readers, with at least two retained manifests and a one-hour grace period.

Responses stream from storage. ETag and Last-Modified come from the manifest;
matching conditional requests return 304 without reading artifact contents.
The main endpoint defaults to `Cache-Control: public, max-age=300`, configurable
with `sitemap.cacheControl`. Versioned generation URLs use immutable caching.

## robots.txt

`web.robots.enabled` registers `/robots.txt`. Configure `groups` and optional
`extra` lines. `referenceSitemap` defaults true and adds the configured
sitemap URL when enabled and an origin exists. A hand-written
`public/robots.txt` wins; maintain its Sitemap line yourself.
