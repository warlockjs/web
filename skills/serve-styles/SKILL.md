---
name: serve-styles
description: 'Serve CSS imported by `root.tsx` or `*.page.tsx`, with render-blocking `<link rel="stylesheet">` delivery from Vite source URLs in development and Vite manifest assets in production. Triggers: `import "./app.css"`, page CSS, `?direct`, `manifest.json`, stylesheet flash, FOUC, `<head>`; "add global styles", "style a page", "CSS missing in SSR", "page flashes unstyled", "serve CSS in production". Skip: root document markup — `@warlock.js/web/write-the-root/SKILL.md`; page authoring — `@warlock.js/web/create-a-page/SKILL.md`; client navigation — `@warlock.js/web/navigate-on-the-client/SKILL.md`; competing styling systems CSS-in-JS, Next CSS, styled-components.'
---

# Warlock — serve styles

Import styles from `root.tsx` for global, render-blocking CSS. A page may also import its own stylesheet, but development and production deliver page-local CSS differently.

## The shape

```tsx title="src/web/root.tsx"
import { Head, Scripts } from "@warlock.js/web";
import type { AppProps } from "@warlock.js/web";
import "./app.css";

export default function App({ children }: AppProps) {
  return (
    <html lang="en">
      <head>
        <Head />
      </head>
      <body>
        <div id="root">{children}</div>
        <Scripts />
      </body>
    </html>
  );
}
```

```css title="src/web/app.css"
:root {
  color-scheme: light dark;
  font-family: system-ui, sans-serif;
}

body {
  margin: 0;
}

main {
  max-width: 72rem;
  margin-inline: auto;
  padding: 2rem;
}
```

Use a bare side-effect import in `root.tsx`. In development the server parses that exact form to discover global styles before rendering the document.

## Development delivery

Development has no client manifest, so Warlock reads `root.tsx`, finds bare stylesheet imports, resolves them relative to the root file, and emits a link before `</head>`:

```html
<link rel="stylesheet" href="/src/web/app.css?direct">
```

The `?direct` query is required: without it Vite serves an imported CSS URL as a JavaScript module, which a stylesheet link cannot apply. With it Vite returns real `text/css`.

Root imports ending in `.css`, `.scss`, `.sass`, `.less`, or `.styl` are recognized. The source file must resolve inside the app root; an outside path is left to the client graph rather than converted to an unsafe `/@fs/` guess.

## Page-local styles

A page may import CSS directly:

```tsx title="src/app/products/web/products.page.tsx"
import "./products.css";

export const route = {
  path: "/products",
  name: "products.index",
} as const;

export default function ProductsPage() {
  return (
    <main className="products-page">
      <h1>Products</h1>
    </main>
  );
}
```

```css title="src/app/products/web/products.css"
.products-page {
  display: grid;
  gap: 1rem;
}
```

Recognized asset imports survive the page's client projection. The client boundary is determined by the import graph, not by the file living under `web/`.

In development, only root stylesheet imports are converted into render-blocking document links. A page-local import is loaded by Vite's client module graph around hydration, so it still applies but is not guaranteed before first paint. Move above-the-fold or site-wide rules into a stylesheet imported by `root.tsx` when avoiding a flash matters.

## Production delivery

The production client build enables Vite's manifest. Vite records emitted CSS against the chunks that imported it. At boot, Warlock reads:

```text
<build.outdir>/client/.vite/manifest.json
```

It collects every valid `css` asset across all manifest entries, deduplicates them in manifest order, and emits each as a render-blocking link before `</head>`.

That means both root-imported and page-imported CSS are linked in the initial production document. The current implementation collects across the whole client manifest rather than selecting only the matched route's CSS, so every page receives the emitted stylesheet set.

Only manifest URLs under the one client asset prefix are emitted; a stylesheet outside the mounted asset directory is dropped instead of producing a dead link.

## Where links land

Stylesheet links are inserted into the rendered HTML immediately before the final `</head>`. They are not rendered by the `<Head />` component itself.

Consequences:

- A custom root must render a real `<head>...</head>` for automatic stylesheet links.
- Root-authored `<link>` and `<style>` elements appear before Warlock's injected stylesheet links, so later injected rules can win normal cascade ties.
- `<Head />` remains responsible for page metadata; the closing `</head>` is what stylesheet installation needs.
- A root with no closing `</head>` is returned unchanged and receives no automatic stylesheet links.

## What ships to the browser

The hydration entry is built from the projected client graph. CSS imports are known-safe asset edges and survive projection even when server exports in the same page module are removed. Application code never imports the published hydration file directly; the web build uses `esm/hydration/index.mjs` as an input and the route handler installs its emitted module URL.

## Diagnose missing or late CSS

1. For global CSS in development, confirm `root.tsx` uses a bare import such as `import "./app.css";`.
2. Confirm the rendered document contains a closing `</head>` and a stylesheet URL ending in `?direct`.
3. For page-local CSS in development, expect Vite's client graph to apply it after hydration; move critical rules to the root import if first paint matters.
4. In production, confirm `.vite/manifest.json` has `css` arrays and the referenced files live under the client asset prefix.
5. Do not hand-author a link to a hashed production asset; its name belongs to the Vite manifest.

## Gotchas

- **Root CSS and page CSS differ in dev.** Root imports are render-blocking; page imports are client-injected.
- **Production currently links all emitted CSS on every page.** It is safe for first paint but not route-minimal.
- **Use a bare root import.** `devStylesheetUrls` scans `import "./app.css"`, not a bound CSS-module import.
- **Keep a closing `</head>`.** Automatic link installation has nowhere safe to write without it.
- **Do not remove `?direct` from a dev stylesheet link.** Vite otherwise responds with JavaScript.
- **Do not import the hydration entry yourself.** The connector owns dev serving and production asset URLs.

## See also

- [`write-the-root/SKILL.md`](../write-the-root/SKILL.md) — the document `<head>` these links enter.
- [`create-a-page/SKILL.md`](../create-a-page/SKILL.md) — page-local asset imports and projection.
- [`navigate-on-the-client/SKILL.md`](../navigate-on-the-client/SKILL.md) — client swaps after the initial styled document.
