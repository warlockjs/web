# Changelog

All notable changes to `@warlock.js/web` are documented here.

## 5.17.0 - Unreleased

### Upgrading

- If your cache driver is redis, pg/database or file, and `globalPrefix` in `src/config/cache.ts` is a function, set `pageCache.namespace` to a value unique to each deployment (for example `"shop-production"`). The page cache now refuses to start on a shared backend without a stable deployment namespace. A static `globalPrefix`, or an in-process driver, needs no change.
- Purge any `serverCache` page-cache entries (and any CDN cache fronting `cache.public` routes) stored by an earlier version — see Security, below. Expect fewer cache HITs afterward: a page visited by a browser carrying any cookie other than the locale cookie (a session cookie under an app-specific name, an analytics cookie, anything else) no longer HITs; it bypasses the page cache and gets `Cache-Control: private, no-store`.

### Features

- Locale URL routing (`web.localeRouting.strategy`). Set it to `"prefix-except-default"` (the default locale stays bare, e.g. `/posts`, every other locale is prefixed, e.g. `/ar/posts`) or `"prefix"` (every locale, including the default, is prefixed) to route locales in the URL instead of `?locale=`. Codes come from `app.localeCodes`, the default from `app.localeCode`; the previously-bare or previously-default URL 301/302-redirects to its prefixed counterpart, with the query string preserved.
- With locale URL routing active, the browser now follows it too: `<Link>`/`href()` prefix an in-app destination with the current locale (skipping the default locale under `"prefix-except-default"`, and never double-prefixing a literal URL that already begins with a routed code), and `changeLocaleCode()` navigates to the current path re-prefixed for the new locale — a real URL change (`pushState`), preserving the query string and hash — instead of the `?locale=` fetch param. Strategy `"none"` (the default) keeps every existing behavior unchanged.
- `[locale]` folder routing. A page whose route's first segment is the param `:locale` — from a `src/web/[locale]/...` folder or an explicit `/:locale/...` route — is locale-routed with no `web.localeRouting` config: a configured code pins `request.locale` before cache lookup and loaders, and any other value renders your `404.page.tsx` (the same path a loader `notFound()` uses). Enabling a `web.localeRouting.strategy` for an app that also has such a page is refused at boot, naming the file, since the two would double-prefix its URL.
- The client half of `[locale]` folder routing: `<Link>`/`href()` fill a route's leading `:locale` param with the current locale when the call site didn't pass one (an explicit `locale` param still wins, and a `:locale` deeper in the path is never filled), and `changeLocaleCode()` on a `[locale]`-routed page navigates to the same path with the first segment swapped for the new locale — a real URL change (`pushState`), preserving the query string and hash, the same as an active `web.localeRouting.strategy`.
- Locale URL routing now reaches the SEO surfaces. With an active `web.localeRouting.strategy` (or a `[locale]`-folder page), the sitemap's per-locale URLs follow the same prefixing rule the server registers — the default locale bare under `"prefix-except-default"`, every code prefixed under `"prefix"` — and `x-default` points at the default locale's own URL instead of always the bare path; an explicit `web.sitemap.localeUrl` or a page's own `localePaths` still wins. A `[locale]`-folder page's own `sitemap` entries substitute the visited code into the route's `:locale` segment. Every locale-routed page's `<head>` also gets `<link rel="alternate" hreflang="...">` for every configured code plus `x-default`, as absolute URLs built from the same `app.publicUrl` origin the sitemap uses; a page that sets its own `metadata.canonical` is left alone. Strategy `"none"` with no `[locale]` page is unchanged: no alternates.
- `localizedPath(path, locale?)` returns the in-app path for the current (or given) locale under the active locale routing, for hand-built URLs such as a page `canonical`. The `<head>` hreflang alternates are emitted even when a page sets its own canonical.
- `<Image>`, a universal image component built from a plain, serializable `ImageDescriptor` (`{src, width, height, variants, formats?}`). Renders a `<picture>` with one `<source type="image/...">` per configured format plus a fallback `<img>`, or just the `<img>` when `image.formats` is unset; width-descriptor `srcSet`s are sorted ascending by variant width regardless of key order, so SSR markup matches hydration byte-for-byte. Reserves layout with `width`/`height`, defaults to `loading="lazy"` and `decoding="async"`, and `priority` switches to `loading="eager"` and `fetchPriority="high"`. `alt` is required (pass `""` for decorative images); a missing `alt` logs a dev-only warning. URLs come from a variant's pre-generated `url`/`urls[format]` when present, otherwise from a swappable `loader` (default: `warlockImageLoader`, which builds `?variant=<name>[&format=]` against core's `/uploads` route). The whole module is client-safe: no Sharp, filesystem or `@warlock.js/core` import reaches its graph.

### Security

- The server-side page cache's pre-lookup bypass previously only recognized an `Authorization` header or the cookie named by `auth.cookie.name` (default `access_token`). An app whose session cookie used a different name (e.g. `token`) could have a signed-in visitor's render STORED, and the next anonymous visitor's request HIT it, receiving the signed-in visitor's data. Any request whose `Cookie` header carries a cookie other than the framework's locale cookie now bypasses cache lookup and is never stored, regardless of `auth.cookie.name`. The same rule forces `Cache-Control: private, no-store` on a `cache.public` route that has no `serverCache`, where it previously could be `public`. A malformed or empty `Cookie` header (`Cookie: `, `Cookie: ;;;`, `Cookie: garbage-no-equals`) fails closed the same way. Purge any page-cache and CDN entries stored by an earlier version after upgrading — see Upgrading, above.

### Fixed

- Page-cache invalidation now always reaches the stored pages. Entries and their tag index used to go through your app's cache `globalPrefix`. Apps that derived it from the request (the scaffold used `Origin`) stored pages on GET under one prefix and invalidated them on POST under another, so nothing was evicted. The page cache now uses its own `warlock.page.<deployment>` namespace, with the Host still part of every key. Invalidation from a background job, with no request, works too.
- A page loader that returns `notFound()` now renders your `404.page.tsx`, with status 404 and noindex, instead of an empty body. Client navigation to such a URL gets the same page.
- A page or layout middleware that already sent its reply (a redirect, `pageAuth`, `forbidden()`) is no longer sent a second time. Before, every guarded redirect logged a false "already-sent" error.
- `changeLocaleCode()` and client navigation install the translations that come with the page data. Before, any translation group registered only on the server (every app's auth and validation messages) made the switch abort in development and render raw keys in production.
- `@warlock.js/web/sitemap`: corrected the 5.16.0 entry below — `warlock build` never generates the sitemap. When `web.sitemap` is enabled, generation happens at runtime boot (`web.sitemap.regenerate.onBoot`) or when the app calls `regenerateSitemap()`, never at build time.
- A detected crawler's inlined deferred value reached `use()` as a raw value instead of a promise, so every page reading it threw "An unsupported type was passed to use()" and crawlers got skeletons instead of content. Inline mode now passes an already-fulfilled thenable that `use()` reads synchronously; the key still stays in the hydration payload with its `__WARLOCK_DEFER__` settlement chunk for JS-capable crawlers. The data-request wire is unaffected. Corrected the 5.12.0 `web.streaming.crawlers` entry below, which claimed crawlers get the resolved document *instead of* deferred chunks — the settlement scripts are retained for JS hydration; only non-JS indexing needs nothing beyond the inlined HTML.
- Crawler documents no longer carry a pending Suspense boundary for deferred sections far down a long page. React outlines a completed boundary (fallback in the HTML, content in a hidden segment swapped in by script) once the page passes about 12.8 KB. Renders that wait for everything to be ready now inline every completed boundary, so non-JS indexers see the content.
- Authenticated requests never get a public `Cache-Control`. A request that used authenticated state (including through `authMiddleware` on a page or layout) is sent `private, no-store`, even on a route that opted into `cache.public`.
- `robots.txt` now covers every locale-prefixed URL under an active `web.localeRouting.strategy`. Before, a rule such as `Disallow: /admin` left `/ar/admin` crawlable, because only the bare path was written. Every `allow`/`disallow` rule that starts with `/` — other than bare `/`, and never a rule containing `*` or `# Changelog

All notable changes to `@warlock.js/web` are documented here.

## 5.17.0 - Unreleased

### Upgrading

- If your cache driver is redis, pg/database or file, and `globalPrefix` in `src/config/cache.ts` is a function, set `pageCache.namespace` to a value unique to each deployment (for example `"shop-production"`). The page cache now refuses to start on a shared backend without a stable deployment namespace. A static `globalPrefix`, or an in-process driver, needs no change.
- Purge any `serverCache` page-cache entries (and any CDN cache fronting `cache.public` routes) stored by an earlier version — see Security, below. Expect fewer cache HITs afterward: a page visited by a browser carrying any cookie other than the locale cookie (a session cookie under an app-specific name, an analytics cookie, anything else) no longer HITs; it bypasses the page cache and gets `Cache-Control: private, no-store`.

### Features

- Locale URL routing (`web.localeRouting.strategy`). Set it to `"prefix-except-default"` (the default locale stays bare, e.g. `/posts`, every other locale is prefixed, e.g. `/ar/posts`) or `"prefix"` (every locale, including the default, is prefixed) to route locales in the URL instead of `?locale=`. Codes come from `app.localeCodes`, the default from `app.localeCode`; the previously-bare or previously-default URL 301/302-redirects to its prefixed counterpart, with the query string preserved.
- With locale URL routing active, the browser now follows it too: `<Link>`/`href()` prefix an in-app destination with the current locale (skipping the default locale under `"prefix-except-default"`, and never double-prefixing a literal URL that already begins with a routed code), and `changeLocaleCode()` navigates to the current path re-prefixed for the new locale — a real URL change (`pushState`), preserving the query string and hash — instead of the `?locale=` fetch param. Strategy `"none"` (the default) keeps every existing behavior unchanged.
- `[locale]` folder routing. A page whose route's first segment is the param `:locale` — from a `src/web/[locale]/...` folder or an explicit `/:locale/...` route — is locale-routed with no `web.localeRouting` config: a configured code pins `request.locale` before cache lookup and loaders, and any other value renders your `404.page.tsx` (the same path a loader `notFound()` uses). Enabling a `web.localeRouting.strategy` for an app that also has such a page is refused at boot, naming the file, since the two would double-prefix its URL.
- The client half of `[locale]` folder routing: `<Link>`/`href()` fill a route's leading `:locale` param with the current locale when the call site didn't pass one (an explicit `locale` param still wins, and a `:locale` deeper in the path is never filled), and `changeLocaleCode()` on a `[locale]`-routed page navigates to the same path with the first segment swapped for the new locale — a real URL change (`pushState`), preserving the query string and hash, the same as an active `web.localeRouting.strategy`.
- Locale URL routing now reaches the SEO surfaces. With an active `web.localeRouting.strategy` (or a `[locale]`-folder page), the sitemap's per-locale URLs follow the same prefixing rule the server registers — the default locale bare under `"prefix-except-default"`, every code prefixed under `"prefix"` — and `x-default` points at the default locale's own URL instead of always the bare path; an explicit `web.sitemap.localeUrl` or a page's own `localePaths` still wins. A `[locale]`-folder page's own `sitemap` entries substitute the visited code into the route's `:locale` segment. Every locale-routed page's `<head>` also gets `<link rel="alternate" hreflang="...">` for every configured code plus `x-default`, as absolute URLs built from the same `app.publicUrl` origin the sitemap uses; a page that sets its own `metadata.canonical` is left alone. Strategy `"none"` with no `[locale]` page is unchanged: no alternates.
- `localizedPath(path, locale?)` returns the in-app path for the current (or given) locale under the active locale routing, for hand-built URLs such as a page `canonical`. The `<head>` hreflang alternates are emitted even when a page sets its own canonical.
- `<Image>`, a universal image component built from a plain, serializable `ImageDescriptor` (`{src, width, height, variants, formats?}`). Renders a `<picture>` with one `<source type="image/...">` per configured format plus a fallback `<img>`, or just the `<img>` when `image.formats` is unset; width-descriptor `srcSet`s are sorted ascending by variant width regardless of key order, so SSR markup matches hydration byte-for-byte. Reserves layout with `width`/`height`, defaults to `loading="lazy"` and `decoding="async"`, and `priority` switches to `loading="eager"` and `fetchPriority="high"`. `alt` is required (pass `""` for decorative images); a missing `alt` logs a dev-only warning. URLs come from a variant's pre-generated `url`/`urls[format]` when present, otherwise from a swappable `loader` (default: `warlockImageLoader`, which builds `?variant=<name>[&format=]` against core's `/uploads` route). The whole module is client-safe: no Sharp, filesystem or `@warlock.js/core` import reaches its graph.

### Security

- The server-side page cache's pre-lookup bypass previously only recognized an `Authorization` header or the cookie named by `auth.cookie.name` (default `access_token`). An app whose session cookie used a different name (e.g. `token`) could have a signed-in visitor's render STORED, and the next anonymous visitor's request HIT it, receiving the signed-in visitor's data. Any request whose `Cookie` header carries a cookie other than the framework's locale cookie now bypasses cache lookup and is never stored, regardless of `auth.cookie.name`. The same rule forces `Cache-Control: private, no-store` on a `cache.public` route that has no `serverCache`, where it previously could be `public`. A malformed or empty `Cookie` header (`Cookie: `, `Cookie: ;;;`, `Cookie: garbage-no-equals`) fails closed the same way. Purge any page-cache and CDN entries stored by an earlier version after upgrading — see Upgrading, above.

### Fixed

- Page-cache invalidation now always reaches the stored pages. Entries and their tag index used to go through your app's cache `globalPrefix`. Apps that derived it from the request (the scaffold used `Origin`) stored pages on GET under one prefix and invalidated them on POST under another, so nothing was evicted. The page cache now uses its own `warlock.page.<deployment>` namespace, with the Host still part of every key. Invalidation from a background job, with no request, works too.
- A page loader that returns `notFound()` now renders your `404.page.tsx`, with status 404 and noindex, instead of an empty body. Client navigation to such a URL gets the same page.
- A page or layout middleware that already sent its reply (a redirect, `pageAuth`, `forbidden()`) is no longer sent a second time. Before, every guarded redirect logged a false "already-sent" error.
- `changeLocaleCode()` and client navigation install the translations that come with the page data. Before, any translation group registered only on the server (every app's auth and validation messages) made the switch abort in development and render raw keys in production.
- `@warlock.js/web/sitemap`: corrected the 5.16.0 entry below — `warlock build` never generates the sitemap. When `web.sitemap` is enabled, generation happens at runtime boot (`web.sitemap.regenerate.onBoot`) or when the app calls `regenerateSitemap()`, never at build time.
- A detected crawler's inlined deferred value reached `use()` as a raw value instead of a promise, so every page reading it threw "An unsupported type was passed to use()" and crawlers got skeletons instead of content. Inline mode now passes an already-fulfilled thenable that `use()` reads synchronously; the key still stays in the hydration payload with its `__WARLOCK_DEFER__` settlement chunk for JS-capable crawlers. The data-request wire is unaffected. Corrected the 5.12.0 `web.streaming.crawlers` entry below, which claimed crawlers get the resolved document *instead of* deferred chunks — the settlement scripts are retained for JS hydration; only non-JS indexing needs nothing beyond the inlined HTML.
- Crawler documents no longer carry a pending Suspense boundary for deferred sections far down a long page. React outlines a completed boundary (fallback in the HTML, content in a hidden segment swapped in by script) once the page passes about 12.8 KB. Renders that wait for everything to be ready now inline every completed boundary, so non-JS indexers see the content.
 — now also emits its prefixed variant for each prefixed locale code, deduped, next to the original. Strategy `"none"` (the default) is unchanged.
- Locale URL routing (`web.localeRouting.strategy`) now actually reaches the browser in a production build. Before, the browser only ever learned the routing strategy from `virtual:warlock/pages`, resolved at BUILD time — wrong whenever the app config wasn't loaded at build time, or differs per environment — so a production bundle could hydrate with `{ strategy: "none" }` while the server was actively locale-routing, silently disabling `<Link>` prefixing and `changeLocaleCode()`. The server document now carries the runtime routing table it actually resolved, as a `<meta name="warlock-locale-routing">` tag rendered by `<Head/>`; the hydration entry reads it before mount and falls back to the build-time value only when the meta is absent or malformed.
- In production, the `:value` placeholder in a page-validation issue message now renders `…` instead of the submitted value, in your translations and in author `errorMessage` templates alike. Before, a translation such as the starter's `enum` message ("given value :value") put the raw query or param value into the error page and the hydration payload. A custom rule that concatenates raw input into its own message text, without `:value`, is not covered and stays your responsibility.
- In production, the sitemap is built from the page manifest. Before, a production build could generate it without the pages' own `sitemap` exports.
- A page's `sitemap` export is stripped from the client bundle in every named-export form, including re-exports (`export { x as sitemap } from "…"`, `export { sitemap } from "…"`). A bare `export * from` in a page module is refused with a clear error, because its export set can't be checked.
- Page `validation` may declare only `params` or only `query`. Before, a page that declared one of them failed every request with `unknownKeys`. Validation now also runs after the app and layout loaders and before the page loader. A layout redirect still wins, and a validation 400 renders your error page inside layouts that received their data.
- In production, a page validation 400 gives `error.page.tsx` a clear message and `error.errors` as `{ input, type, error }` entries. The submitted values are never included. Other unexpected errors keep the generic message and `errorCode`.

## 5.16.0 - 2026-09-18

### Upgrading

- In production, unexpected page errors no longer send their `message` to the browser. If your error page showed `error.message` to visitors, throw `PublicPageError` for messages meant for them. Other errors now show a generic message and an `errorCode`.

### Added

- `@warlock.js/web/sitemap`: `sitemap.xml` and `robots.txt` for web apps. Configure them under `web.sitemap` and `web.robots` in `src/config/web.ts`. Pages control their own listing with `export const sitemap` (`false`, static options, or a function that supplies URLs for dynamic routes). Locales expand into hreflang alternates, and web switches to a sharded `SitemapIndex` above 50,000 URLs. The sitemap is generated at runtime boot (`web.sitemap.regenerate.onBoot`) or when the app calls `regenerateSitemap()` — never at `warlock build` and never while serving a request. See 5.17.0.
- Web now wraps every page in a default client error boundary. A rejected `defer()` value with no app boundary renders the app's error page, or a built-in fallback, instead of unmounting the tree. The boundary resets on every navigation, refresh and locale change.
- `PublicPageError`: throw it, or reject a deferred value with it, when its `message` is meant for visitors. In production, only a `PublicPageError` message reaches the browser.
- Loaders receive `signal`, an `AbortSignal` that fires when the client disconnects.
- Development only: during client navigation, web checks that a page's translations were registered by `register()` before anything renders.
- `pageCache.maxEntryBytes` (default 1 MiB): a cache miss larger than this is still served in full but is not cached.

### Changed

- **BREAKING (production error disclosure):** in production, an unexpected page error no longer sends its `message` to the browser. The browser gets a generic message plus an `errorCode` that matches the server's error report, and `stack` is never sent. Throw `PublicPageError` for messages visitors should see.

### Fixed

- A client disconnect now aborts SSR, NDJSON navigation streams and loader work, and stream errors no longer escape as uncaught exceptions. A refresh or locale change aborts the fetches it supersedes.
- Deferred values are scoped per navigation, so late chunks from an abandoned navigation can no longer settle the active page. Finished scopes are released from memory.
- SSR and client navigation now fall back the same way for missing metadata fields.
- The dev client page registry keeps a custom `appSrcRoot`.
- In development, page discovery for unmatched requests is cached until a page file changes.

## 5.15.0 - 2026-09-18

### Fixed

- `useTrans()` no longer silently returns the raw key after hydration. The active locale's translations now ride in the hydration payload and register on the client before `hydrateRoot`, so a translated string survives hydration instead of being reconciled away. Server-rendered HTML was always correct, which is what made this invisible.

### Changed

- **BREAKING:** `listRoutablePages` is exported from `@warlock.js/web/build`, not the root barrel. It reaches the filesystem-walking page discovery, and on the root barrel that module joined the import graph of every page importing `@warlock.js/web` — a generated app answered 500 on every route in dev. A boundary spec now fails if the root barrel reaches `src/build/**`.
- The hydration payload carries a seventh required key, `translations`, holding **only the active locale's** entries — never every locale.

## 5.14.0 - 2026-09-17

### Changed

- **BREAKING:** the hydration mount is `<div id="vessel">` (was `#root`), which no longer collides with embeds and widgets. Update custom `root.tsx` files and any `#root` CSS or tests; hydration errors name the rename when `#root` is found.
- Dev SSR externalises every installed `@warlock.js/*` package (derived, not a hand list), so no family package can load twice and split its state.

### Security

- **BREAKING:** the client-build secret scan refuses every reference to the global `process`, including aliased forms (`const p = globalThis.process`, `const { env } = process`, `window.process`). Use `import.meta.env` instead of `typeof process` checks.

### Fixed

- A local variable or parameter named `process` in client code is no longer falsely refused.
- Cached pages send one `Vary` value on both HTML and data responses: HTML now varies on `x-warlock-data`, and deferred pages keep `Vary: User-Agent`.
- The typed translation-key guard now actually runs as part of `typecheck`.

## 5.13.0 - 2026-09-17

### Upgrading

- The server page cache key now includes the request `Host`. If you run `serverCache` in a multi-tenant/multi-host deployment, invalidate or let expire any entries stored before upgrading, since a pre-upgrade entry was keyed without `Host` and could otherwise be conflated with the wrong tenant on a cache HIT.

### Added

- `linkStylesheetsFor(request, sourceFile)`: middleware or a loader declares a lazily imported module (e.g. a per-tenant theme from a static `import()` map), and the module's CSS is added to that response's render-blocking `<head>` links. Dev resolves it through the module graph, production through the Vite manifest. Before this, a lazy theme painted unstyled until client JS loaded its CSS. An unknown id throws `UnknownStylesheetSourceError` and a malformed id throws `InvalidStylesheetSourceError`. See the new `multi-theme` skill.
- `route.cache.varyBy?: (request) => string` adds a request-derived component to the server page cache key, and a function-form `route.cache.tags` now receives `{ shared }` as its second argument, e.g. for tagging entries by theme.
- `useTrans()` now accepts generated, literal translation keys. `warlock dev` augments web's `TranslationKeyRegistry` from registered `groupedTranslations` dictionaries; before generation it safely accepts `string`.

### Fixed

- **BREAKING:** The server page cache key now includes the request `Host`. Before, two hosts (tenants) serving the same URL shared one entry, so tenant B could be served tenant A's document and `shared` payload. This also closed a Host-header cache-poisoning path.
- The server page cache now stores the streamed document the MISS visitor received, not the synchronous `renderToString` pass. That pass rendered a not-yet-resolved `React.lazy` boundary as its Suspense fallback, so every later HIT replayed the fallback.
- `warlock dev`: a `serverCache: true` page no longer answers 500 `CacheDriverNotInitializedError`. An app `resolveAlias` entry for a framework package made Vite ignore `ssr.external` and load a second, never-booted copy. Dev SSR now always imports `@warlock.js/core`, `cache`, `logger`, `context` and `cascade` from the instance the app booted, as production does, and drops app aliases that would re-inline an SSR-external package.
- A page request that fails outside the page pipeline (a cache failure, a module that fails to load) is now logged to stderr as `[warlock:web] page request <METHOD> <path> failed: <error>`. Before, the error reached only the app's `error.page.tsx` and the server log stayed empty.
- `peerDependencies.react` and `react-dom` tightened from `"*"` to `^19.0.0` — `web` is only built and tested against React 19 (see `devDependencies`), so the peer range now says so instead of accepting any major.
- Projection no longer refuses a type-only import (`import type {} from "./x"`, `import type { X } from "./x"`, `import { type X } from "./x"`) as an attribution-ambiguous statement. A type-only import is erased at build and carries no runtime binding, so it can never reach the client — it was wrongly falling into the "bare side-effect import" refusal. A mixed import (`import { type A, B } from "./x"`) still has its value specifier checked exactly as before.

## 5.12.0 - 2026-09-16

### Added

- Emitted scripts carry the request's CSP nonce.
- `<ClientOnly>` and `useIsClient()` — render browser-only UI with a server fallback and no hydration mismatch.
- `defer()` in page loaders — stream a slow top-level loader key in after the shell instead of blocking the first byte on it, read it with React's `use()` inside `<Suspense>`. A rejection or a `web.streaming.deferTimeout` timeout resolves to the nearest `<Suspense>` error boundary with status 200 already sent, never a different HTTP status. Client navigations stream the same values as NDJSON automatically. `metadata()` may read only resolved keys — reading a deferred one throws `DeferredKeyInMetadataError`, naming the key and the page, in dev and in production. See the `stream-deferred-data` skill.
- Scroll position is restored on back/forward client navigation, keyed per history entry and persisted to `sessionStorage`. New navigations scroll to the top, or to the hash fragment when there is one.
- `localeDirection(locale)` and `useTextDirection()`: one locale-to-direction resolver shared by server and client. Root templates set `<html lang={locale} dir={useTextDirection()}>`.
- `changeLocaleCode(code)` switches the active locale without a full reload. The server persists the choice in its `locale` cookie when a navigation data request carries `?locale=`.
- Page requests report `loader` (per level), `render.shell` and `stream.end` phases through core's `http.tracing` hooks when tracing is enabled (off by default).
- `web.streaming.crawlers` — a detected crawler's full-document request now gets every `defer()`-ed value awaited and inlined in the HTML before the first byte, so indexing needs nothing else; a rejection renders the ordinary error boundary with its real status. The document still carries the normal `__WARLOCK_DEFER__` settlement scripts so a JS-capable crawler hydrates `use(data.key)` through the existing registry same as any other visitor. Detection is case-insensitive against a documented built-in user-agent list (googlebot, bingbot, yandex, duckduckbot, baiduspider, slurp, applebot, facebookexternalhit, twitterbot, linkedinbot, discordbot, slackbot, telegrambot, whatsapp, embedly, pinterest); set `crawlers: false` to disable detection, or `crawlers: { userAgents, detect }` to customise it — `detect` wins outright when given. A page that uses `defer()` now sends `Vary: User-Agent` on its document response; a page that never defers is unaffected. See the `stream-deferred-data` skill's "Crawlers" section.
- **A server-side page cache, opt-in per route.** Extends `route.cache` with `serverCache?: boolean`, `tags?: string[] | ((data) => string[])`, and an optional `ttl` — separate from `public`/`maxAge`, which only decide the downstream CDN's `Cache-Control`. A `serverCache` route holds its resolved document AND `x-warlock-data` JSON, and serves a HIT without re-running loaders or rendering. The cache key is the normalised path, sorted query, resolved locale and representation (`html`/`json`); a request for the NDJSON representation is served the fully-resolved `json` variant instead of streaming. A request carrying an `Authorization` header or the configured auth cookie (`auth.cookie.name`, default `access_token`) always bypasses the cache, before any loader runs. Storage requires `GET`, `status === 200`, no `Set-Cookie`, and a provably unauthenticated request — the same fail-closed rule already governing `Cache-Control`. Responses carry a new `x-warlock-cache: hit | miss | bypass` header. Invalidate stored entries with `invalidatePageCache(tags)`, imported from the server-only subpath `@warlock.js/web/page-cache` (it reaches `@warlock.js/cache`, so it stays off the client-reachable root barrel). `@warlock.js/cache` is an optional peer, loaded only when a route actually opts in; enabling `serverCache` with an in-process cache driver (memory/LRU/memory-extended) in a clustered deployment logs a one-time warning, since invalidation on one worker never reaches another — use a shared driver (redis/pg) for cluster-wide invalidation. See the `create-a-page` skill's "Server-side page cache" section.

### Changed

- **The page-data wire format is now devalue, not plain JSON.** Dates, Maps and Sets (and BigInts, `undefined` inside an object, repeated references, and cyclic structures) now arrive in the browser intact — as real `Date`/`Map`/`Set` instances, not flattened strings or dropped keys — for `appData`, `layoutData`, `pageData`, and a `defer()`red value's settlement, on the initial document, a client navigation's data response, and its NDJSON stream. A loader value devalue cannot serialize (a class instance it does not recognize, a function, a symbol) now fails the build loudly in dev **and** production, naming the loader level (`app`/`layout`/`page`), the key path, and the page route — give it a resource or a `toJSON()` instead. `shared` is unaffected: it keeps its own, stricter gate. See the `load-page-data` skill's "What survives the wire" section.
- The dev and production page installers now share the layout-prefix table and the not-found route's options instead of implementing each twice; parity checks cover both.
- Pages are rendered with React's streaming renderer. The response still waits for loaders, validation and middleware, so status codes, headers and cookies are unchanged — the document simply starts arriving sooner.

### Fixed

- `document.documentElement`'s `lang`/`dir` now follow a client-side locale switch — `changeLocaleCode()`, and any navigation or refresh whose payload carries a different `locale`. Previously `useLocale()`/`useTextDirection()` updated in-page immediately, but `documentElement` kept the last full load's `lang`/`dir` until a reload, because `root.tsx` sits outside the hydrated subtree.
- **A page middleware that short-circuits a full page load now always answers with something, never a silently empty document.** Previously, a middleware that returned a value WITHOUT writing the reply itself (e.g. `response.setStatusCode(403); return { error }`, or a plain `return { message }`) produced a blank document at that status — the returned value was recorded but never used. A middleware that already wrote its own reply (`response.redirect()`, `.forbidden()`, any call reaching `.send()`) was and is unaffected: the wire already carried the real answer. Now: a `>= 400` short-circuit renders your `error.page.tsx` boundary with that status and the returned value attached to the error; a `2xx` short-circuit sends the returned value as the body, unchanged (JSON-stringified if it's an object) — a page middleware returning 2xx content replaces the page. Client navigations (data requests) are byte-identical to before.

## 5.11.0 - 2026-09-14

### Changed

- **A page load that fails `validation` now renders your `error.page.tsx` with status 400** and the validation errors, instead of a blank 400 response. Client navigations are unchanged. If you relied on the empty body, check your error page handles a 400.
- The dev and production page installers now compose a layout level's middleware and loaders through one shared rule, and a parity check covers middleware and loaders as well as rendering and prefixes.

## 5.10.0 - 2026-09-14

### Fixed

- The `load-page-data` skill described the withdrawn `{ schema }`-only validation shape and a 422 status; it now documents `validation = { params, query }` and its single 400.

### Removed

- Unused internal `RouteValidationError`.

## 5.9.0 - 2026-09-13

### Added

- Dev diagnostic when a `.client` module is reached from the **server** import graph. The `.client` suffix is a developer marker, not enforced isolation (the import graph decides where code runs); this emits a named, non-fatal warning identifying the offending edge instead of silently over-promising.

### Internal

- Umbrella dev/prod route-table parity differential — a pure test pinning the production route derivation against the shared rule the dev installer uses, so any future re-split of the derivation fails loudly.

## 5.8.0 - 2026-09-13

### Fixed

- Dev SSR now emits the page's stylesheet `<link>` in `<head>`, fixing a cold module-graph flash-of-unstyled-content — the first paint of a page whose CSS is reached only through the module graph is now styled in development, as it already was in production.
- A dev-mode SSR render error now reaches an unconditional stderr floor with a real diagnostic, instead of a diagnostic-free generic 500.

## 5.7.0 - 2026-09-11

### Removed

- **`route.validate` and `route.middleware` are withdrawn, one release after 5.6.0 added them.** They were a second way to say what the top-level `validation` and `middleware` exports already said, on the same file — and the two validation surfaces disagreed about the status code. **Migration is a move, not a rewrite:** the schema shape is unchanged (`params` and `query` stay separate, never merged) and the failure is still 400.

  ```diff
  - export const route = { path: "/products/:id", validate: v.object({ … }), middleware: [guard] } as const;
  + export const route = { path: "/products/:id" } as const;
  + export const validation = { params: v.object({ … }), query: v.object({ … }) };
  + export const middleware = [guard];
  ```

  **A page still declaring either one refuses to boot and names the file.** It is never silently ignored — which for `route.middleware` is the difference between a deploy that fails and a route that serves without its auth guard.

### Fixed

- **Dev and production agree about stylesheets.** A stylesheet reached only through a component import was collected by production's bundler-graph walk and was structurally invisible to dev's scan of the page file — so a page rendered unstyled in development and correct in production. Both sides now end in one traversal, gated by a fixture built through **both** pipelines with the outputs diffed.
- **A client navigation whose data payload is incomplete now loads the page normally instead of rendering it blank.** Navigation carried its own copy of the payload rule and checked two of the six required keys, so a payload that could not render a page was accepted and handed to React anyway; the failure surfaced later, somewhere else, pointing at nothing. It now falls back to a full page load — slower for that one click, and the page arrives.
- **The dev server no longer says it is watching for changes while it is not yet serving.** On a slow boot that line arrived up to three minutes before the port was bound; every word of it was true and the impression it left was false.
- **The `create-a-page` skill and `llms-full.txt` taught `route.validate` and `route.middleware`** — with a complete worked example — after both were withdrawn. Following our own documentation produced an app that would not start.

### Changed

- The dev and production page installers now agree on the layout **chain**, the layout **level**, and the hydration entry URL by construction rather than by inspection, each gated with a red control. The three places they still differ — live `public/` serving, its cache header, and hashed-asset caching — are deliberate and are now declared in the code that implements them.

## 5.6.0 - 2026-09-08

### Added

- **A page can declare its input contract on its `route` export.** The export now accepts an object as well as a string: `{ path, name?, cache?, validate?, middleware? }`. `validate` is a Seal schema over `{ params, query }` — kept separate, never merged — and the validated value reaches the loader typed from the schema. A failure renders the **error page at 400** carrying the failure, and travels the same way over the client-navigation wire. Layout middleware runs outermost-first with the page's own last, so a layout's auth gate cannot be bypassed by a page that declares its own.
- `useQueryString(key)` — a subscription to one query-string parameter that re-renders on client navigation. Wiring it up exposed that `routerEvents` was only ever fired by `refresh()`: `<Link>` and browser back/forward emitted nothing, so anything subscribed to navigation silently never updated. Navigation now emits its events on every path.

### Fixed

- **Every rendered page returned 500 in `warlock dev`.** The dev server decided the client/server boundary by FILE LOCATION — anything under `src/web/**` was treated as inherently client-safe — which contradicts the rule the production build applies and made a server-only import reachable from the client graph. Dev now decides the boundary by the import graph, exactly as production does.
- **A page route could not be served at all in `warlock dev`.** The handler read the Fastify instance from the container while running inside Vite's SSR module graph, where that lookup can never hit. The instance is now resolved on the Node side and handed in.
- **Page files were ignored in silence.** A `*.page.tsx` or a layout under `src/app/**/web/**` was discovered by nothing and reported by nothing — an app with seven pages served zero. Discovery now NAMES every file it ignores, at boot, and for a layout it says what was lost: its `prefix`, `middleware` and `loader` apply to no page, so a guard a page relied on is silently absent.
- **A file added to `public/` after the last build 404'd in production with no diagnostic.** The build-time snapshot is deliberate and stays — but production now names the files its snapshot missed instead of failing them wordlessly.
- One page that fails to import no longer takes the whole dev boot down with it.
- Writing to `shared` from the browser failed with a message that read as a fixable wiring bug — "the server bootstrap must call `connectSharedStore(...)`". It now names the value, explains that what the client holds is a dead server-render snapshot that can never be written to, and says what to use instead.
- The `public/` staleness check runs on every client build rather than only some.

### Changed

- **The dev and production page installers now share their composition rules** — layout-level selection, loader folding, route identity, and the duplicate-route message — instead of implementing them twice. A route collision reported in dev used to quote a dev-only file path in a message production also raises.
- The published `./vite` subpath is a barrel again: the connector no longer authors Vite plugins, so importing the runtime never drags the build tooling in behind it.
- Importing the metadata linter no longer pulls 4544 modules and 18 MB into a build-tool module for the sake of one function; it now costs 17 modules.
- One name for one thing: "runtime" everywhere, `hydration/` renamed to `entry/`, and four files renamed to match what they contain.

## 5.5.0 - 2026-09-07

### Fixed

- Documentation shipped in this package's `skills/` told users to run `pnpm`-specific commands. `pnpm <binary>` has no npm equivalent, so those instructions failed outright for anyone not using pnpm. Commands are now package-manager neutral.

## 5.3.2 - 2026-09-05

### Fixed

- A page-file segment carrying a bracket but no complete group could reach the parameter-name read with nothing to read. Unreachable as the surrounding checks stand, and now stated as a guard rather than assumed, so a future narrowing of those checks fails here naming the segment instead of throwing further down.

## 5.3.1 - 2026-09-04

### Fixed

- Republished the complete family so a clean install resolves. Same code as 5.3.0, published as one complete set.

## 5.3.0 - 2026-09-03

### Added

- A standalone Warlock 404 page, styled and served by the web layer.
- Request-bound web localization: the active locale travels with the request rather than being read from ambient state.

### Fixed

- The 404 page's stylesheet was imported through a Vite-only `?url&inline` query, which the release bundler could not resolve — the web package could not be built for publication at all. The stylesheet URL is now produced by a plain module, guarded by a test that keeps the emitted markup byte-exact against the CSS file.
- A directory that owned a layout `prefix` was never classified, so bracket syntax inside a group name went unexamined and two different pages could derive the same route. Every directory name is now validated before the route decides whether it contributes.
- A page's DECLARED `route.path` was never validated — the validator had zero callers.
- Bracket syntax inside a group name is rejected instead of silently deriving a route.
- `discover-pages` now composes paths through the same validated seam as the rest of routing, so the two can no longer disagree.
- An unobservable auth mark revokes a cache opt-in: unproven now means revoked, not assumed safe.

## 5.2.3 - 2026-09-02

### Fixed

- The generated Web starter now projects and hydrates unchanged with one `index` page identity, universal localization registration, and deterministic browser markup.

## 5.2.2

### Fixed

- Restored exact Core and Seal peer pins at the family's shared 5.2.2 version.
  The partial 5.2.1 release could not satisfy reciprocal family peer pins.

## 5.2.1

### Fixed

- Tightened the Core and Seal peer ranges to `^5.2.0`. Web 5.2 production
  code imports Core APIs that were not available in Core 5.0, while the former
  Seal `*` range promised compatibility across unrelated major versions.

## 5.2.0

### Added

- **`error.page.tsx`** — the application's one error boundary. It renders when
  a middleware, loader, or component throws; declares no `route`, exactly like
  `404.page.tsx`; and a second `error.page.tsx` anywhere beneath `src/web` is a
  build error. Its component receives `{ error, status }` — the real thrown
  value during SSR, a JSON-safe `{ name, message, stack? }` after hydration.
  `robots: noindex` is a framework default on this path and cannot be
  overridden away. If the failure happens before any page module could load —
  a module-load or `register()` throw — the response falls back further, to a
  framework-owned boundary with no application code at all, and is served
  without a hydration script rather than risk hydrating against markup nothing
  can vouch for.
- **A page's `route` export is now optional.** A `*.page.tsx` with no `route`
  derives its path and its name from its location beneath `src/web`:
  directories contribute segments, `(group)` directories contribute nothing,
  `index.page.tsx` claims its own directory, and `[id]` becomes `:id`. An
  explicit `route` still always wins over the derived one. This replaces the
  5.1 behaviour, where an omitted `route` threw `MissingRouteExportError` at
  install time — that error class no longer exists.
- **Live page-route re-registration in `warlock dev`.** Creating, deleting, or
  editing a page's `route` export used to require a manual restart to take
  effect — the route table was built once at boot and never again, so a
  renamed route kept serving its old path and a deleted page kept 404-ing at
  its old URL forever. The dev connector now re-registers the affected routes
  in place, atomically, with no dev-server restart and no loss of Vite's HMR
  state. A component-body-only edit still takes the ordinary Fast Refresh
  path; only membership and route-identity changes go through this path.
- **A dev-only diagnostic for a page file that exists but isn't reachable.**
  When a request 404s, Warlock checks whether an unregistered `*.page.tsx`
  under `src/web` would have matched it, and if so, warns naming the file.
  This is the case that used to be silent: a page created after boot, or one
  whose `route` was edited to a path nothing else claims, previously 404'd
  with no explanation anywhere in the terminal.
- **`export const register`** — an optional, synchronous, no-argument hook on
  `root.tsx`, `layout.tsx`, and `*.page.tsx`. It runs once per module
  namespace instance, on both the server and the browser, before that
  module's middleware or loader — the seam for one-time setup a page or
  layout needs on both sides of hydration. It must not return a Promise;
  returning one throws.

### Changed

- **Page requests now tolerate one trailing slash identically in development
  and production.** `/about` and `/about/` serve the same page; `/` remains the
  root path and case handling is unchanged. Previously the development
  dispatcher accepted the slash while the production Fastify route returned 404.

- ⚠ **BREAKING — `process.env` is refused entirely in the client/universal
  graph, and there is no `PUBLIC_` exception.** Neither a static key
  (`process.env.PUBLIC_API_URL`) nor a computed one (`process.env[key]`) is
  allowed: `process` does not exist in a browser, so there is no such thing as
  a "public" `process.env` key. **Bare value-reads of the object now fail
  too** — `const { X } = process.env`, `{ ...process.env }`,
  `Object.keys(process.env)`, `JSON.stringify(process.env)`, or passing it as
  an argument — which is the case that previously let an entire server
  environment reach a component in one line while every keyed read was being
  refused. `globalThis.process.env`, `window.process.env` and
  `process["env"]` are matched as well.

  **Enforcement now covers dev SSR as well as the client bundle, and a
  violation fails the build** rather than being a production-only surprise.
  Files under `node_modules` stay out of scope by design — a dependency's own
  `process.env.NODE_ENV` guard is not the application's problem.

  ⚠ **`env("PUBLIC_X")` does not work client-side either**, and never did:
  `env` comes from `@warlock.js/core`, which declares itself server-only, so
  the import is refused before the call is ever examined. **The supported
  pattern is to read the value in a page loader — server code — and pass it to
  the page as loader data:**

  ```tsx
  export const loader = (async () => ({
    siteName: env("PUBLIC_SITE_NAME"),
  })) satisfies PageLoader;

  export default function HomePage({ data }: PageProps<typeof loader>) {
    return <h1>{data.siteName}</h1>;
  }
  ```

  If a value must genuinely be inlined into browser code instead of passed as
  loader data, the one supported spelling is `import.meta.env.PUBLIC_*` with a
  static key — Vite's env surface, baked in at build time, so it cannot vary
  per request. Server-side code is unrestricted.

- ⚠ **BREAKING — a `*.page.tsx` with no default export is now a hard
  discovery/build failure, naming the file.** It previously built and
  registered, then served a blank `200` at its URL — a page that looked
  deployed, rendered nothing, and produced no error anywhere.

  ```
  The page "src/web/contact.page.tsx" has no runtime default export. Every
  `*.page.tsx` file must default-export the React component it renders.
  ```

  `export { Page as default }` satisfies the rule — the check is for a runtime
  default binding, not for the keyword form. `export default interface Page {}`
  does not: a type-only default is erased and leaves no component behind. A
  file that cannot be parsed reports as a parse failure instead, so a syntax
  error never masquerades as a missing export.

- **Initial stylesheet links are route-scoped in development and production.**
  Each response now links the ordered, deduplicated CSS chain for its own
  `[root, ...matched layouts, page]`. Production follows those source entries
  and their static imports in Vite's manifest instead of collecting CSS across
  the whole application; development promotes direct stylesheet imports from
  the matched page and layouts as well as the root. Unrelated page CSS no
  longer ships on every response, and page-local critical CSS no longer waits
  for hydration in development.
- **The production static-asset refusal now names the working 5.2 alternative.**
  Imported non-stylesheet assets still work under Vite in development but are
  refused by the esbuild server bundle rather than risk a server/client URL
  mismatch. The diagnostic now tells the developer to place the file under the
  application's `public/` directory and reference its root URL
  (`public/logo.svg` → `/logo.svg`) instead of waiting for an unspecified future
  server build. Stylesheet imports remain supported.
- **Loader execution is sequential, root to leaf, and terminal responses stop
  lower work.** The `root.tsx` App loader runs first, followed by every matched
  layout loader from outermost to innermost, then the page loader. The runtime
  has three top-level slots (`app`, `layout`, `page`), but the layout slot
  composes the full matched layout chain. A page still has at most one
  _rendering_ layout; loader-only and middleware-only layouts may appear at
  multiple ancestry levels.

  ⚠ **This package's own documentation previously described the three levels as
  running in parallel, and told you not to rely on ordering between them.** The
  implementation now awaits the App slot, the composed outer-to-inner layout
  slot, and the Page slot in that order.

  **The first core `Response` a loader returns is terminal**: it stops every
  lower loader from starting, and — because the response is returned whole — it
  also bypasses buffer commit and metadata resolution, discarding the header
  and cookie writes buffered at that same level. A short-circuit
  (`response.redirect()`, `response.notFound()`) commits its own level's buffer
  inclusively and is the right choice when those writes should survive; a throw
  discards the throwing level's buffer and commits only the levels above it.

- **Catch-all page routes are documented as unsupported.** `[...slug].page.tsx`
  does not do what it looks like: filesystem routing recognizes only `[name]` as
  a dynamic segment, so `[...slug]` is taken as a **literal** segment and derives
  the path `/docs/[...slug]` and the name `docs.[...slug]` — reachable only at
  the literal URL `/docs/%5B...slug%5D`. ⚠ **Nothing warns about it**: no build
  error, no dev warning, no refusal, just a page that answers a URL nobody will
  request. A real catch-all is deferred; until then use a terminal wildcard with
  an explicit route (`route = { path: "/docs/*" }`). This entry records the gap,
  it does not close it.

- **`src/web` is the only page root.** A per-module `src/app/<module>/web/`
  tree is no longer discovered, walked, or installed as a page root by either
  `warlock dev` or `warlock build`. Move any page, layout, or root file that
  lived under `src/app/<module>/web/` into `src/web/` (a subdirectory is
  fine — it still contributes a route segment the same way).

### Fixed

- **A custom `404.page.tsx` loader no longer executes.** The not-found page
  still registers and renders its real module namespace, but its request
  triple omits the page loader in both development and production. A missing
  URL therefore cannot trigger application data work, redirect, or fail a
  second time through the fallback itself.

  Precisely what is skipped, because "the 404 page doesn't run loaders" is a
  useful shorthand and not the whole rule: only the **page-level `loader`** is
  omitted. The real module namespace is still used, so `register()` runs and
  the component renders normally, and the page's **middleware still runs**.
  Layout loaders don't run because this page has an empty layout chain by
  construction, not because loaders are disabled on it. And the **`root.tsx`
  App loader does still run** on a 404 request — keep it cheap, and make sure
  it tolerates a request that matched nothing.

## 5.1.0

> **Upgrade if you installed 5.0.0, 5.0.1 or 5.0.2.** React did not execute at all in
> a published install of any of them — see the first entry under _Fixed_. Every
> interactive page shipped on those versions was inert in the browser.

### Added

- **`404.page.tsx`** — an app-owned not-found page. It renders only when `text/html`
  is explicitly present in the request's `Accept` header, so an unmatched `/api/...`
  path still returns the JSON 404 an API client expects rather than a document. It
  renders with no layouts: discovery reports an empty layout chain for this page only,
  so the client hydration registry matches what the server has always rendered instead
  of wrapping a failure page in chrome that can itself throw or need data. Ordinary
  pages beside it keep their full layout chain, and nested-layout refusal on its path
  is unchanged.
- **`export const metadata` is typed (`PageMetadata`) and checked at build time.** An
  unannotated object literal with a misspelled key — `{ tittle: "x" }` — now fails the
  build, naming the file, the line and the offending key. It previously typechecked as
  a plain object and was silently ignored at runtime.
- **Fast Refresh in dev now applies only when an edit is confined to component
  bodies.** Any module-level change — an import, a module-level declaration, or any
  server export, `metadata` included — forces a full page reload instead of a stale hot
  update; a JSX-only edit still hot-updates in place with component state intact.

### Changed

- **`warlock dev` now refuses a `*.page.tsx` that exports no route**, throwing
  `MissingRouteExportError` and naming the file. It previously 404'd silently, so a
  missing `export const route` looked like a routing bug at request time. This matches
  what `warlock build` already did — dev and build now reject the same file.

### Removed

- **A false comment shipped in 5.0.0 through 5.0.2** claiming that a page's route is
  derived from its file location. No such derivation has ever existed in this package;
  the route comes from the page's `route` export and nothing else. The comment is gone
  from the scaffold emitted by `warlock add web`, but **every app scaffolded on 5.0.0,
  5.0.1 or 5.0.2 still carries it in its own source** — delete it by hand.

### Fixed

- **React did not run at all in published installs of 5.0.0 through 5.0.2.** The dev
  Vite server served `react-dom/client` as raw CJS, so `hydrateRoot` did not exist and
  the hydration module threw while being parsed. This one defect is the cause of all
  four symptoms reported against those versions: `useState` never updated, Fast Refresh
  never ran, metadata never refreshed, and `<Link>` fell back to a full page reload.
  Fixed by declaring the React entries in the dev server's `optimizeDeps` so they are
  pre-bundled to ESM before the browser asks for them. This is not a hydration
  _improvement_ — hydration did not happen.
- **The browser was loading two copies of every `@warlock.js/web` client module.**
  Module-level state (context, the navigation runtime) existed twice, so a value written
  through one copy was invisible to the component reading the other.

## 5.0.2 - 2026-08-25

### Fixed

- **`<Head/>` read an empty document context under SSR.** The connector now sets
  `ssr.noExternal: ["@warlock.js/web"]` in `web-connector.ts`. Without it the server
  loaded two instances of this package — one externalised, one bundled — so the context
  the renderer wrote to was not the one `<Head/>` read from. A published 5.0.1 install
  that returned 500 on a page request returns 200 after this fix.

## 5.0.1 - 2026-08-25

### Changed

- Narrowed the `vite` peer dependency to `">=7.3.5 <8"`, so a consumer resolving vite
  for this package cannot land on a version outside the range it is built against.

### Fixed

- Internal: a test in `gate-b-secrets.spec.ts` depended on the ambient `NODE_ENV` and
  failed depending on how the suite was invoked. No runtime behaviour changed.

## 5.0.0 - 2026-08-25

**First published release.**

### Added

- SSR React pages with hydration, client navigation, route metadata, shared data, and Vite integration.

### Changed

- The hydration runtime is packaged as its own public entry, and production/dev route wiring now resolves the packaged client manifest and stylesheets.

## 4.16.0

**First published release.** The package existed in the monorepo but was absent
from the release registry, so it had never reached npm.

### Added

- SSR React pages served by the Warlock HTTP server. A page route is an ordinary
  Warlock route whose handler renders React instead of returning JSON.
- Hydration, and client-side navigation via `<Link>` — no document reload, Back
  and Forward included.
- React Fast Refresh in `warlock dev`, including a server render that reflects
  the edit rather than the pre-edit module.
- Typed links: `href(name, params, query)`; an unknown route name is a compile
  error.
- `revalidate()` — re-run the current route's loaders after a mutation.
- MRR's navigation API mirrored by name (`navigateTo`, `navigateBack`,
  `currentRoute`, `queryString`, …) without depending on that package.
- `warlock add web` scaffolds `src/web/` and registers the connector.

### Fixed

- `metadata()` no longer runs when a loader rejected. It used to be called with
  `data: undefined` while the type promised otherwise, so a metadata function
  reading its data threw a `TypeError` that **replaced the loader's real error**
  and pointed at the wrong file.
- Validation reads the same query the loader reads. Stage 4 took `query` and
  `params` from a hand-parsed URL while `body` and `headers` came from the
  request — so `?tags=a&tags=b` reached validation as `"b"`, and a rule on
  `filter.status` never fired because validation saw a key literally named
  `filter[status]`.
- `href()` emits the query grammar core actually parses; nested objects and
  arrays are no longer destroyed by `String(value)`.
