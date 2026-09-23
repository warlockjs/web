---
name: write-the-root
description: 'Author `src/web/root.tsx`, the full-document application root that owns `<html>`, `<head>`, and `<body>`, places page metadata with `<Head />`, renders the hydrated subtree inside `#vessel`, and emits the payload with `<Scripts />`. Triggers: `root.tsx`, `AppProps`, `AppLoader`, `Head`, `Scripts`, `id="vessel"`; "customize the root document", "add html lang", "add an app provider", "where do Head and Scripts go"; typical import `import { Head, Scripts, type AppProps } from "@warlock.js/web"`. Skip: page component contract — `@warlock.js/web/create-a-page/SKILL.md`; layout wrappers — `@warlock.js/web/use-layouts/SKILL.md`; CSS delivery — `@warlock.js/web/serve-styles/SKILL.md`; competing roots `next/layout`, Remix `root`, React `createRoot`.'
---

# Warlock — write the root

`src/web/root.tsx` is the application document. Its default export renders the complete `<html>` tree and contains the one DOM node the browser hydrates: `#vessel`.

Use optional `root.setup.ts` for root `config`, loader, or universal
`register()` while `root.tsx` remains the document component. `strictMode` is
statically projected from the setup file. Do not value-import setup from the UI;
type-only imports are allowed, and duplicate exports fail.

The root may export `config`, `loader`, `register`, `ErrorBoundary`, and its
default component. `RootConfig` owns `middleware`, `strictMode`, and metadata.
Route/prefix, cache, validation, sitemap, and robots-file policy are not root
exports. Keep sitewide sitemap and robots serving in `web.sitemap` and
`web.robots`; page and layout policy belongs in their own `config` exports.

## The shape

```tsx title="src/web/root.tsx"
import { Head, Scripts } from "@warlock.js/web";
import type { AppProps } from "@warlock.js/web";

export default function App({ children }: AppProps) {
  return (
    <html lang="en">
      <head>
        <Head />
        <link rel="icon" href="/favicon.svg" />
      </head>
      <body>
        <div id="vessel">{children}</div>
        <Scripts />
      </body>
    </html>
  );
}
```

The root component is synchronous. HTTP work belongs in an `AppLoader`; the component receives its result as `data`.

## `lang` and `dir`

The root owns `<html>`, so it also owns `lang` and `dir` — the framework never injects either. Read the current locale with `useLocale()` and derive the writing direction from it with `useTextDirection()`, both from `@warlock.js/web`:

```tsx title="src/web/root.tsx"
import { Head, Scripts, useLocale, useTextDirection } from "@warlock.js/web";
import type { AppProps } from "@warlock.js/web";

export default function App({ children }: AppProps) {
  const locale = useLocale();

  return (
    <html lang={locale} dir={useTextDirection()}>
      <head>
        <Head />
      </head>
      <body>
        <div id="vessel">{children}</div>
        <Scripts />
      </body>
    </html>
  );
}
```

`useTextDirection()` derives `"rtl"` or `"ltr"` from the same locale `useLocale()` already exposes — via `localeDirection()`, a pure function safe to call on the server or the client. No hydration payload change is involved: the direction is computed from the locale that already made the trip, not carried separately.

To switch the active locale without a full reload, call `changeLocaleCode(code)`. The switch commits a browser locale preference only after the replacement tree is ready, so a failed or superseded request cannot change the next document load. `lang` and `dir` follow the committed locale on the next render (and every render after).

### `useTrans()` and route translations

The hydration payload carries the selected route-locale translation snapshot.
`LocaleProvider` receives that snapshot and `useTrans()` translates from it;
route JSON is not registered into a process-global localization table. The
snapshot contains the active locale only, so a request or client navigation
cannot inherit another route's keywords.

## `#vessel` is the hydration boundary

The server renders this document shape:

```text
App document
└── #vessel
    └── Layout
        └── Page
```

The browser hydrates `#vessel`, not the whole document. The client tree deliberately contains Layout + Page and excludes App because App contains the mount point. Keep exactly one element with `id="vessel"` around `{children}`. It may be nested inside your own body markup, but it must not be renamed or omitted.

Because App is outside the hydrated subtree, put client state that must survive navigation in a layout or component beneath `#vessel`, not in the document root.

If `root.tsx` (or any module it needs) fails to load or its `register()` throws, there is no trustworthy Layout+Page composition left to hydrate — Warlock falls back to a plain document with no hydration script at all rather than hydrate the browser against markup nothing can vouch for. See [create-a-page](../create-a-page/SKILL.md) for the app's own `error.page.tsx` boundary, which is tried first.

## `<Head />`

`<Head />` renders the resolved page metadata at that position. It takes no props and emits:

- `<meta charset="utf-8">`
- title, description, keywords, canonical, and robots tags
- Open Graph and Twitter tags

Do not also hard-code a `<title>` for the current page; that produces two titles. Static root-wide tags such as a favicon or application name can sit beside `<Head />`.

## `<Scripts />`

`<Scripts />` emits the escaped `application/json` payload that hydration and client navigation consume, followed by the hydration client entry `<script type="module">` (Stage 1 streaming SSR renders both through React now, in this one component — see below). Put it after `#vessel`, normally near the end of `<body>`.

For a Content Security Policy nonce:

```tsx title="src/web/root.tsx"
import { Head, Scripts } from "@warlock.js/web";
import type { AppProps } from "@warlock.js/web";

export default function App({ children, shared }: AppProps) {
  return (
    <html lang="en">
      <head>
        <Head />
      </head>
      <body>
        <div id="vessel">{children}</div>
        <Scripts nonce={(shared as { nonce?: string }).nonce} />
      </body>
    </html>
  );
}
```

Prefer declaring `nonce` on `SharedContext` so the cast is unnecessary; see [load-page-data](../load-page-data/SKILL.md). If no prop is supplied, `<Scripts />` falls back to the framework's request nonce slot.

**This is the same nonce a `Content-Security-Policy` header would enforce.**
`@warlock.js/core`'s opt-in `http.csp` (5.12.0 — see its `configure-app` and
`send-response` skills) builds `script-src 'self' 'nonce-<value>'` from the
identical per-request `request.nonce`. The framework's own emitted
`<script>` tags — the payload script and the hydration client entry module,
both rendered by `<Scripts />` — already carry that nonce automatically;
nothing in an app's `root.tsx` needs to change to make those two work
together. The prop above only matters if your root renders its OWN inline
`<script>` tags that need to pass the same policy.

`<Scripts />` owns both the inline data payload and the hydration client
entry module — Stage 1 streaming SSR moved the entry module off a post-render
string splice and onto real React output, read from the same document
context the payload script already reads (`hydrationClientModuleUrl`). Its
published `esm/hydration/index.mjs` file is a build input and must never be
imported by application code.

## Add an application loader

```tsx title="src/web/root.tsx"
import { Head, Scripts } from "@warlock.js/web";
import type { AppLoader, AppProps } from "@warlock.js/web";

export const loader = (async () => {
  return { applicationName: "Warlock Store" };
}) satisfies AppLoader;

export default function App({ data, children }: AppProps<typeof loader>) {
  return (
    <html lang="en">
      <head>
        <Head />
        <meta name="application-name" content={data.applicationName} />
      </head>
      <body>
        <div id="vessel">{children}</div>
        <Scripts />
      </body>
    </html>
  );
}
```

The App loader runs first and is awaited before the outermost layout loader starts; matched layout loaders then run outermost to innermost before the page loader. Its return is for the App component; use `shared` for request data that multiple levels need.

## Root middleware and Strict Mode

Use the optional root config for guards that must run before layout and page
middleware:

```tsx
import type { RootConfig } from "@warlock.js/web";
import type { Middleware } from "@warlock.js/core";

const attachRequestContext: Middleware = ({ request }) => {
  request.locals.startedAt = Date.now();
};

export const config: RootConfig = {
  middleware: [attachRequestContext],
  strictMode: true,
};
```

`loader`, `register`, and `ErrorBoundary` remain separate exports. Named
`sitemap` or route-policy exports are invalid. Root metadata may be static or a
server-only callback; it participates in title and field composition with
layouts and the page. A callback returns the root's complete level: explicit
fields override `child`, while omitted child fields are not retained. Preserve
descendant metadata deliberately by spreading `child`:

```tsx
export const config: RootConfig = {
  metadata: ({ data, child }) => ({
    ...child,
    title: `${data.applicationName} | ${child?.title ?? "Home"}`,
  }),
};
```

The callback may override a child title; an absolute child title remains
authoritative. Static root metadata still merges with child metadata.

`strictMode` defaults to `false`, preserving existing applications. New Web
scaffolds enable it with `strictMode: true`. The root owns this setting even
though the document component is not mounted in the browser: Warlock projects
the flag into hydration and wraps the complete page, layout, and navigation
tree beneath `#vessel` in React `StrictMode`.

Strict Mode's development checks can run effects and their cleanup an extra
time, so make client setup and cleanup idempotent. These extra checks do not run
in production.

## Gotchas

- **The root owns the complete document.** Return `<html>`, `<head>`, and `<body>`, not a fragment.
- **Keep `{children}` inside `#vessel`.** Server rendering can still look correct without it, but hydration cannot mount.
- **Render `<Head />` in a custom root.** It is what turns the page's `metadata` into elements.
- **Render `<Scripts />` in a custom root.** Without the payload script, the browser cannot hydrate the server-rendered page.
- **Do not make the component `async`.** Load data with `AppLoader`.
- **Do not import browser-only state into the root expecting it to persist.** The client hydrates the subtree inside the root, not the root itself.
- **Stylesheet links are installed separately.** They are inserted before `</head>`; read [serve-styles](../serve-styles/SKILL.md) for the dev/production rules.

## See also

- [`create-a-page/SKILL.md`](../create-a-page/SKILL.md) — the Page level rendered under the root.
- [`use-layouts/SKILL.md`](../use-layouts/SKILL.md) — the persistent wrapper inside `#vessel`.
- [`load-page-data/SKILL.md`](../load-page-data/SKILL.md) — `AppLoader` and typed `shared`.
- [`serve-styles/SKILL.md`](../serve-styles/SKILL.md) — global CSS from `root.tsx`.
