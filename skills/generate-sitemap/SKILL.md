---
name: generate-sitemap
description: 'Serve `/sitemap.xml` and `/robots.txt` from a Warlock web app with the `@warlock.js/web/sitemap` subpath — the `web.sitemap` and `web.robots` keys in `src/config/web.ts`, the page-level `export const sitemap` (opt out, static options, or a supplier for dynamic routes), locale/hreflang expansion, the automatic switch to a sharded `SitemapIndex`, when generation runs (`warlock build`, boot, or `regenerateSitemap()`), the 503-before-first-generation rule, and `MissingPublicUrlError`. Triggers: `web.sitemap`, `web.robots`, `WebSitemapConfig`, `RobotsConfig`, `SitemapPageExport`, `export const sitemap`, `regenerateSitemap`, `generateSitemap`, `MissingPublicUrlError`, `splitByLocale`, `localeUrl`, `referenceSitemap`, `warlock add sitemap`; "add a sitemap to my Warlock site", "dynamic route missing from sitemap.xml", "regenerate the sitemap after publishing a post", "robots.txt", "sitemap returns 503", "hreflang in the sitemap". Skip: the framework-blind builder classes themselves (`Sitemap`, `SitemapIndex`, Express/cron usage) — `@warlock.js/sitemap/sitemap-overview/SKILL.md`; `app.publicUrl` — `@warlock.js/core/configure-app/SKILL.md`; page metadata `robots: noindex` — `@warlock.js/web/create-a-page/SKILL.md`; competing tools `next-sitemap`, `sitemap` npm package direct.'
---

# Warlock — generate a sitemap and robots.txt

`@warlock.js/web` turns the app's page graph into `sitemap.xml` and serves it,
plus an optional generated `robots.txt`. `@warlock.js/sitemap` owns the XML
protocol; web is its caller — it discovers pages, expands locales, picks the
single-file or sharded builder, and wires the routes.

## Turn it on

`warlock add sitemap` installs `@warlock.js/sitemap` and merges a **disabled**
`sitemap` section into `src/config/web.ts` (creating the file when missing).
There is no `src/config/sitemap.ts` and no connector to register — web reads
`web.sitemap` itself.

Two steps to enable it:

1. Set the public origin: `app.publicUrl` in `src/config/app.ts`, or the
   `PUBLIC_APP_URL` environment variable. The origin is never guessed from a
   request host.
2. Flip `sitemap.enabled` to `true`.

```ts
import type { RobotsConfig, WebSitemapConfig } from "@warlock.js/web/sitemap";

const webConfig: { sitemap: WebSitemapConfig; robots: RobotsConfig } = {
  sitemap: {
    enabled: true,
    path: "/sitemap.xml",
    defaults: { changefreq: "weekly", priority: 0.5 },
    locales: { codes: ["en", "ar"], defaultLocale: "en" },
  },
  robots: {
    enabled: true,
    groups: [{ userAgent: "*", disallow: ["/admin"] }],
  },
};

export default webConfig;
```

`@warlock.js/web/sitemap` is a separate subpath, not the root barrel — it
reaches page discovery, which a page's own graph must never pull in.

## `web.sitemap` keys

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `false` | Nothing is discovered, generated or routed until `true`. |
| `path` | `/sitemap.xml` | The served path of the single file or the index. |
| `outputDir` | `storagePath("sitemap")` | Where files are written. Must be a directory the sitemap owns outright — publishing replaces it whole, and `@warlock.js/sitemap` refuses a non-empty directory it did not create (`UnownedOutputDirectoryError`). Never point it at `public/`. |
| `gzip` | `false` | On the sharded path, write each shard as `.xml.gz` instead of `.xml`. |
| `defaults` | — | `changefreq` / `priority` applied to every entry that does not set its own. |
| `locales.codes` | `app.locales` | Locale codes each page is expanded into, with `xhtml:link` hreflang alternates. |
| `locales.defaultLocale` | — | Also emitted as `x-default`. Unset: no `x-default`. |
| `locales.splitByLocale` | `false` | One shard per locale, listed in an index. |
| `localeUrl` | `path?locale=<code>` | Override how a path becomes a locale URL — only when the app implements its own prefix routing. A page's `localePaths` still wins. |
| `regenerate.onBoot` | `true` | Generate at boot (dev and production). `warlock build` never generates — see below. |

Above 50,000 URLs (or with `splitByLocale`) web switches from a single
`Sitemap` to a sharded `SitemapIndex` automatically; `path` then serves the
index and each shard is served at `/<shard file>`.

## Per-page control: `export const sitemap`

Every routable page is included by default, expanded per locale. Error pages
are never listed. A page module can export `sitemap` to change that:

```tsx
export const sitemap = false;
```

```tsx
export const sitemap = { priority: 0.9, changefreq: "daily", locales: false };
```

The object form takes `priority`, `changefreq`, `lastmod`, `locales: false`
(one locale-invariant URL) and `localePaths` (per-locale slugs).

**A dynamic route (`/posts/:slug`) is not a URL.** Only a supplier function
can name its concrete paths; without one the route contributes nothing and is
reported with `count: 0` in the result's `routes`, never silently dropped:

```tsx
export const sitemap = async () => [
  { path: "/posts/hello-world", lastmod: new Date("2026-09-01") },
  { path: "/posts/second-post", localePaths: { ar: "/posts/thani" } },
];
```

In a real page, read the rows from your model — the function runs at
generation time, not per request.

## When it runs — never on a request

`warlock build` never generates the sitemap — the build process loads no app
config and ships no page source files, so it logs
`[warlock:web] sitemap: generated at production boot (web.sitemap.regenerate.onBoot) — not at build time`
and leaves generation to boot. Generation happens at boot (dev and
production) when `regenerate.onBoot` is on, and whenever the app calls
`regenerateSitemap()`:

```ts
import { regenerateSitemap } from "@warlock.js/web/sitemap";

export async function onPostPublished(): Promise<void> {
  await regenerateSitemap();
}
```

- A call while a generation is running joins it instead of starting another.
- A failed run keeps serving the last good set and is always reported to
  stderr. A boot never fails because the sitemap did.
- `/sitemap.xml` only ever serves what was last written. Before the first
  successful generation it answers **503 with `Retry-After`**, never a 404 and
  never a generation on the request's behalf.

`generateSitemap()` is the underlying one-shot call (no join, no last-good
tracking); it throws `MissingPublicUrlError` when `enabled` is `true` and no
origin is configured, before any page is read.

## `web.robots`

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `false` | Registers `GET /robots.txt`. |
| `groups` | — | `{ userAgent, allow?, disallow? }` blocks. |
| `referenceSitemap` | `true` | Appends `Sitemap: <origin><web.sitemap.path>` when the sitemap is enabled and has an origin. |
| `extra` | — | Raw lines appended verbatim (`Host:`, `Crawl-delay:`). |

A hand-written `public/robots.txt` wins outright: web registers no route and
warns that the `Sitemap:` line is then yours to add.

## Pitfalls

- **503 on `/sitemap.xml`** — no generation has succeeded yet. Check the
  build/boot log for `[warlock:web] sitemap regeneration failed`; a missing
  `app.publicUrl` is the usual cause.
- **A dynamic page is missing** — it has no `export const sitemap` supplier.
  Its route shows up with `count: 0` in the generation result.
- **`outputDir` inside `public/`** — refused. The sitemap owns its directory.
