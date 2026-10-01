---
name: serve-styles
description: 'Serve CSS imported by `root.tsx` or `*.page.tsx`, with render-blocking `<link rel="stylesheet">` delivery from Vite source URLs in development and Vite manifest assets in production. Also covers Tailwind v4 setup (`warlock add tailwind`, `postcss.config.mjs`, `@import "tailwindcss"`). Triggers: `import "./app.css"`, `tailwind`, `postcss.config.mjs`, page CSS, `?direct`, `manifest.json`, stylesheet flash, FOUC, `<head>`; "add global styles", "style a page", "CSS missing in SSR", "page flashes unstyled", "serve CSS in production", "add Tailwind", "Tailwind classes not applied". Skip: root document markup — the `write-the-root` topic; page authoring — the `create-a-page` topic; client navigation — the `navigate-on-the-client` topic; competing styling systems CSS-in-JS, Next CSS, styled-components.'
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
        <div id="vessel">{children}</div>
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

<!-- prettier-ignore -->
```html
<link rel="stylesheet" href="/src/web/app.css?direct">
```

The `?direct` query is required: without it Vite serves an imported CSS URL as a JavaScript module, which a stylesheet link cannot apply. With it Vite returns real `text/css`.

Root imports ending in `.css`, `.scss`, `.sass`, `.less`, or `.styl` are recognized. The source file must resolve inside the app root; an outside path is left to the client graph rather than converted to an unsafe `/@fs/` guess.

## Page-local styles

A page may import CSS directly:

```tsx title="src/web/products/products.page.tsx"
import "./products.css";
import type { PageConfig } from "@warlock.js/web";

export const config: PageConfig = {
  route: { path: "/products", name: "products.index" },
};

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

That support is specific to stylesheets in the production page graph. An imported non-stylesheet asset such as `import logo from "./logo.svg"` works under Vite in development but is refused by `warlock build`. Put it in the application's `public/` directory and reference its root URL instead: `public/logo.svg` is `/logo.svg`.

For each matched handler, Warlock builds one ordered CSS chain: `[root, ...matched layouts, page]`. A stylesheet imported directly by any member of that chain becomes a render-blocking link in the initial document in both development and production. Unrelated pages and layouts do not contribute CSS to this response.

## Production delivery

The production client build enables Vite's manifest. Vite records emitted CSS against the chunks that imported it. At boot, Warlock reads:

```text
<build.outdir>/client/.vite/manifest.json
```

For each source in the matched handler chain, Warlock finds that source's manifest entry, collects its own CSS plus CSS from statically imported chunks, and emits the ordered, deduplicated result as render-blocking links before `</head>`. It does not follow `dynamicImports`, because doing so would pull unrelated lazy pages into the response.

That means root-, matched-layout-, and page-imported CSS are linked in the initial production document without shipping another page's stylesheet set.

Only manifest URLs under the one client asset prefix are emitted; a stylesheet outside the mounted asset directory is dropped instead of producing a dead link.

## Per-request stylesheets (lazily imported modules)

A module imported with `import()` — a theme picked per tenant — is not in the handler chain, and production never follows `dynamicImports`. Its CSS would only arrive from client JavaScript, after an unstyled first paint. Declare it for the request instead, from middleware or a loader:

```ts
linkStylesheetsFor(request, "src/web/themes/alpha/alpha-theme.tsx");
```

The id is the module's app-root-relative source path. Its CSS (plus its static imports' CSS) is linked after the chain's links, for this response only: module graph in dev, manifest in production. An id the build does not know throws `UnknownStylesheetSourceError`; a malformed id throws `InvalidStylesheetSourceError`. See the `multi-theme` topic.

## Where links land

Stylesheet links are inserted into the rendered HTML immediately before the final `</head>`. They are not rendered by the `<Head />` component itself.

Consequences:

- A custom root must render a real `<head>...</head>` for automatic stylesheet links.
- Root-authored `<link>` and `<style>` elements appear before Warlock's injected stylesheet links, so later injected rules can win normal cascade ties.
- `<Head />` remains responsible for page metadata; the closing `</head>` is what stylesheet installation needs.
- A root with no closing `</head>` is returned unchanged and receives no automatic stylesheet links.

## What ships to the browser

The hydration entry is built from the projected client graph. CSS imports are known-safe asset edges and survive projection even when server exports in the same page module are removed. Application code never imports the published hydration file directly; the web build uses `esm/hydration/index.mjs` as an input and the route handler installs its emitted module URL.

## Tailwind CSS (v4)

Tailwind is not part of `@warlock.js/web`; it is the `tailwind` feature of the Warlock CLI. It needs only a stylesheet imported from `root.tsx` plus a PostCSS config, because Vite runs PostCSS over every imported stylesheet.

**What the scaffold ships** (a new app from `create-warlock` with the web layer):

- `postcss.config.mjs` at the project root, registering the v4 adapter:

  ```js title="postcss.config.mjs"
  export default {
    plugins: {
      "@tailwindcss/postcss": {},
    },
  };
  ```

- `src/web/app.css`, whose first line is `@import "tailwindcss";` (the scaffold also `@import`s its page CSS after it).
- `import "./app.css";` in `src/web/root.tsx`, the bare side-effect import described above.
- `tailwindcss` and `@tailwindcss/postcss` (both `^4.1.16`) in `devDependencies`.

**Enable it in an existing app:**

```bash
npx warlock add tailwind
```

The feature requires `web` (it resolves it first), adds the two dev dependencies to `package.json`, then:

1. creates `src/web/app.css` containing `@import "tailwindcss";` (skipped if the file exists, so a re-run never overwrites your design tokens),
2. creates `postcss.config.mjs` (skipped if any PostCSS config already exists; it prints `plugins: { "@tailwindcss/postcss": {} }` for you to add by hand, because two PostCSS configs in one project is undefined behaviour),
3. prepends `import "./app.css";` to `src/web/root.tsx` as its first line (skipped if the root already imports `app.css`; if `root.tsx` is missing it prints the line for you to add).

Afterwards confirm both packages are in `node_modules`, and run your package manager's install if they are not. To do it by hand, do those three things yourself: install `tailwindcss` and `@tailwindcss/postcss`, create the PostCSS config, and add the stylesheet with `@import "tailwindcss";` imported from `root.tsx`.

Notes:

- **There is no `tailwind.config.js` in v4.** Configuration is CSS: design tokens go in an `@theme { ... }` block in `app.css`, plugins are `@plugin "...";` lines beside the import. The engine finds the class names in your templates through the bundler graph, so there are no `content` globs to maintain.
- **Put the import in `root.tsx`**, not in a page, so the utilities are linked for every route (a stylesheet imported by the root is part of every response's CSS chain; see "Page-local styles").
- **Use the PostCSS file, not `@tailwindcss/vite`.** The only app-facing Vite plugin hook is `webConnector({ plugins })`, and it feeds the development server only; the production client build composes its own plugin list. A Tailwind Vite plugin registered there would style `warlock dev` and silently vanish from `warlock build`. The PostCSS config is found from the app root in both: the dev server is rooted at the app, and the production client build points Vite's PostCSS discovery at the app root explicitly.
- Tailwind output is ordinary imported CSS, so everything above (the `?direct` dev link, the manifest-linked production link, `</head>` placement) applies unchanged. If utilities are missing in production, run through "Diagnose missing or late CSS" below.

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

- The `write-the-root` topic: the document `<head>` these links enter.
- The `create-a-page` topic: page-local asset imports and projection.
- The `navigate-on-the-client` topic: client swaps after the initial styled document.
