# @warlock.js/web

**SSR React pages, served by the Warlock HTTP server.**

Warlock is a backend platform that renders React — not a React framework with a
server bolted on. This package adds a page layer to an existing Warlock app
without changing what that app already is.

> **A page route is an ordinary Warlock route whose handler renders React
> instead of returning JSON.**

One route table. One matcher. One middleware chain. One validation stage. One
request context. A page and an API endpoint are the same thing up to the point
where one returns data and the other returns a document.

## Install

```bash
warlock add web
```

That installs the package, scaffolds `src/web/` with a root and one page, and
registers the connector in `warlock.config.ts`. Pages are opt-in: a Warlock app
is an API until you run this.

## A page

```tsx
// src/web/products.page.tsx
import type { PageLoader, PageProps } from "@warlock.js/web";
import { productsRepository } from "app/products/repositories/products.repository";
import { productResourceCollection } from "app/products/resources/product.resource";

export const route = "/products";

/**
 * A loader IS a controller: full Warlock context, the same DI, the same guards.
 * It returns data instead of a response — and it may mutate the response on the
 * way past, which a server-component framework structurally cannot do.
 */
export const loader = (async ({ response }) => {
  response.header("cache-control", "private, max-age=60");

  return { products: productResourceCollection(await productsRepository.all()) };
}) satisfies PageLoader;

/** Server-only. Runs after the loader and receives its data. */
export const metadata = ({ data }) => ({
  title: "Products",
  description: `${data.products.length} in stock`,
});

/** Runs twice — server render, then hydration. Never `async`. */
export default function ProductsPage({ data }: PageProps<typeof loader>) {
  return (
    <ul>
      {data.products.map(product => (
        <li key={product.id}>{product.name}</li>
      ))}
    </ul>
  );
}
```

`warlock dev` serves it. `warlock build` + `warlock start` serves it in
production.

## What you get

- **Server-side rendering with hydration.** Not RSC — RSC is a written non-goal.
- **Client-side navigation.** `<Link>` swaps the page without a document reload;
  Back and Forward included.
- **React Fast Refresh in dev.** Edit a component, keep your state, and the
  server renders the new output too.
- **Typed links.** `href(name, params, query)` — an unknown route name is a
  compile error.
- **Loaders that are controllers.** Full request context, guards, DI, and the
  ability to set headers, cookies and status during the render.
- **`refresh()`.** POST to your own API, call it, and the page's loaders
  re-run without pushing history. There is no `revalidate()` export.
- **Return values are Resources, never models.** A model does not survive the
  wire: it carries methods, a connector handle and every column.

## The two halves of a page file

| Server-only | Runs twice (server + browser) |
|---|---|
| `route`, `middleware`, `validation`, `loader`, `metadata`, `prefix` (layouts only) | default `Page` / `Layout`, `register` |

The server half is stripped before anything reaches the browser. The runs-twice
half never receives `request` or `response` — it also executes in a browser,
where neither exists — and is never `async`.

## Routing

A page's URL is its `route` export when it declares one. A page with no
`route` derives its URL from its own location beneath `src/web`: directories
contribute segments, `(group)` directories contribute nothing, `index.page.tsx`
claims its directory, and `[id]` becomes `:id`. A layout's `prefix` still
composes in front of either form. `route`, when present, always wins.

`src/web` is the only page root — a per-module `src/app/<module>/web/` tree is
not scanned.

Exactly two page filenames are special: `404.page.tsx` (the not-found page,
reached by not matching, never declares `route`, renders with no layout) and
`error.page.tsx` (the application's one error boundary, also declares no
`route`). There is no `500.page.tsx`; an unmatched URL is not an error.

In development, creating, deleting, or editing a page's `route` export updates
the live route table without restarting `warlock dev`.

## Where things live

```
src/web/                    app-level web layer and page root
  root.tsx                  owns <html>, renders #root
  layouts/                  shared layouts
  middleware/
```

All client code lives in `src/web/`, so `rm -rf src/web` removes the page layer
and leaves a working API.

**`web/` means the web layer, not the browser.** Loaders and page middleware
inside it are server code.

## Requirements

- `@warlock.js/core`
- `react` and `react-dom` 19+
- `vite` and `@vitejs/plugin-react` — dev-only, loaded lazily, optional peers

## Documentation

The reference application in the Warlock repository (`v5/app`) is the worked
example: layouts, auth-gated pages, forms posting to real controllers, locale
handling, and error boundaries.

## License

MIT
