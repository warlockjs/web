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

```tsx title="src/web/products/products.page.tsx"
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

```css title="src/web/products/products.css"
.products-page {
  display: grid;
  gap: 1rem;
}
```

Recognized stylesheet imports survive the page's client projection. The client boundary is determined by the import graph, not by the file living under `web/`.

That support is specific to stylesheets in the production page graph. An imported non-stylesheet asset such as `import logo from "./logo.svg"` works under Vite in development but is refused by `warlock build` in 5.2. Put it in the application's `public/` directory and reference its root URL instead: `public/logo.svg` is `/logo.svg`.

For each matched handler, Warlock builds one ordered CSS chain: `[root, ...matched layouts, page]`. A stylesheet imported directly by any member of that chain becomes a render-blocking link in the initial document in both development and production. Unrelated pages and layouts do not contribute CSS to this response.

## Production delivery

The production client build enables Vite's manifest. Vite records emitted CSS against the chunks that imported it. At boot, Warlock reads:

```text
<build.outdir>/client/.vite/manifest.json
```

For each source in the matched handler chain, Warlock finds that source's manifest entry, collects its own CSS plus CSS from statically imported chunks, and emits the ordered, deduplicated result as render-blocking links before `</head>`. It does not follow `dynamicImports`, because doing so would pull unrelated lazy pages into the response.

That means root-, matched-layout-, and page-imported CSS are linked in the initial production document without shipping another page's stylesheet set.

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

1. In development, confirm the root, matched layout, or page imports the stylesheet directly with a bare import such as `import "./app.css";`.
2. Confirm the rendered document contains a closing `</head>` and a stylesheet URL ending in `?direct`.
3. If CSS is imported indirectly through another JavaScript module in development, Vite's client graph still applies it, but Warlock's source scan cannot promote it to a render-blocking link; import critical CSS directly from a chain member.
4. In production, confirm `.vite/manifest.json` has a source entry for the matched root/layout/page and that its `css` arrays reference files under the client asset prefix.
5. Do not hand-author a link to a hashed production asset; its name belongs to the Vite manifest.

## Gotchas

- **CSS is scoped to the matched handler chain.** Root CSS is shared; only the current route's matched layouts and page add their direct imports.
- **Use a bare direct import.** `devStylesheetUrls` scans `import "./app.css"` in each chain member, not a bound CSS-module import or an import hidden behind another JavaScript module.
- **Keep a closing `</head>`.** Automatic link installation has nowhere safe to write without it.
- **Do not remove `?direct` from a dev stylesheet link.** Vite otherwise responds with JavaScript.
- **Do not import the hydration entry yourself.** The connector owns dev serving and production asset URLs.

## See also

- [`write-the-root/SKILL.md`](../write-the-root/SKILL.md) — the document `<head>` these links enter.
- [`create-a-page/SKILL.md`](../create-a-page/SKILL.md) — page-local asset imports and projection.
- [`navigate-on-the-client/SKILL.md`](../navigate-on-the-client/SKILL.md) — client swaps after the initial styled document.
