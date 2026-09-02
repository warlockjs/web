---
name: write-the-root
description: 'Author `src/web/root.tsx`, the full-document application root that owns `<html>`, `<head>`, and `<body>`, places page metadata with `<Head />`, renders the hydrated subtree inside `#root`, and emits the payload with `<Scripts />`. Triggers: `root.tsx`, `AppProps`, `AppLoader`, `Head`, `Scripts`, `id="root"`; "customize the root document", "add html lang", "add an app provider", "where do Head and Scripts go"; typical import `import { Head, Scripts, type AppProps } from "@warlock.js/web"`. Skip: page component contract — `@warlock.js/web/create-a-page/SKILL.md`; layout wrappers — `@warlock.js/web/use-layouts/SKILL.md`; CSS delivery — `@warlock.js/web/serve-styles/SKILL.md`; competing roots `next/layout`, Remix `root`, React `createRoot`.'
---

# Warlock — write the root

`src/web/root.tsx` is the application document. Its default export renders the complete `<html>` tree and contains the one DOM node the browser hydrates: `#root`.

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
        <div id="root">{children}</div>
        <Scripts />
      </body>
    </html>
  );
}
```

The root component is synchronous. HTTP work belongs in an `AppLoader`; the component receives its result as `data`.

## `#root` is the hydration boundary

The server renders this document shape:

```text
App document
└── #root
    └── Layout
        └── Page
```

The browser hydrates `#root`, not the whole document. The client tree deliberately contains Layout + Page and excludes App because App contains the mount point. Keep exactly one element with `id="root"` around `{children}`. It may be nested inside your own body markup, but it must not be renamed or omitted.

Because App is outside the hydrated subtree, put client state that must survive navigation in a layout or component beneath `#root`, not in the document root.

If `root.tsx` (or any module it needs) fails to load or its `register()` throws, there is no trustworthy Layout+Page composition left to hydrate — Warlock falls back to a plain document with no hydration script at all rather than hydrate the browser against markup nothing can vouch for. See [create-a-page](../create-a-page/SKILL.md) for the app's own `error.page.tsx` boundary, which is tried first.

## `<Head />`

`<Head />` renders the resolved page metadata at that position. It takes no props and emits:

- `<meta charset="utf-8">`
- title, description, keywords, canonical, and robots tags
- Open Graph and Twitter tags

Do not also hard-code a `<title>` for the current page; that produces two titles. Static root-wide tags such as a favicon or application name can sit beside `<Head />`.

## `<Scripts />`

`<Scripts />` emits the escaped `application/json` payload that hydration and client navigation consume. Put it after `#root`, normally near the end of `<body>`.

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
        <div id="root">{children}</div>
        <Scripts nonce={(shared as { nonce?: string }).nonce} />
      </body>
    </html>
  );
}
```

Prefer declaring `nonce` on `SharedContext` so the cast is unnecessary; see [load-page-data](../load-page-data/SKILL.md). If no prop is supplied, `<Scripts />` falls back to the framework's request nonce slot.

`<Scripts />` owns the inline data payload. The separate hydration module is appended by the page route handler. Its published `esm/hydration/index.mjs` file is a build input and must never be imported by application code.

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
        <div id="root">{children}</div>
        <Scripts />
      </body>
    </html>
  );
}
```

The App loader runs first and is awaited before the outermost layout loader starts; matched layout loaders then run outermost to innermost before the page loader. Its return is for the App component; use `shared` for request data that multiple levels need.

## Gotchas

- **The root owns the complete document.** Return `<html>`, `<head>`, and `<body>`, not a fragment.
- **Keep `{children}` inside `#root`.** Server rendering can still look correct without it, but hydration cannot mount.
- **Render `<Head />` in a custom root.** It is what turns the page's `metadata` into elements.
- **Render `<Scripts />` in a custom root.** Without the payload script, the browser cannot hydrate the server-rendered page.
- **Do not make the component `async`.** Load data with `AppLoader`.
- **Do not import browser-only state into the root expecting it to persist.** The client hydrates the subtree inside the root, not the root itself.
- **Stylesheet links are installed separately.** They are inserted before `</head>`; read [serve-styles](../serve-styles/SKILL.md) for the dev/production rules.

## See also

- [`create-a-page/SKILL.md`](../create-a-page/SKILL.md) — the Page level rendered under the root.
- [`use-layouts/SKILL.md`](../use-layouts/SKILL.md) — the persistent wrapper inside `#root`.
- [`load-page-data/SKILL.md`](../load-page-data/SKILL.md) — `AppLoader` and typed `shared`.
- [`serve-styles/SKILL.md`](../serve-styles/SKILL.md) — global CSS from `root.tsx`.
