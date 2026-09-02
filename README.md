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

  return {
    products: productResourceCollection(await productsRepository.all()),
  };
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
      {data.products.map((product) => (
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

| Server-only                                                                        | Runs twice (server + browser)         |
| ---------------------------------------------------------------------------------- | ------------------------------------- |
| `route`, `middleware`, `validation`, `loader`, `metadata`, `prefix` (layouts only) | default `Page` / `Layout`, `register` |

The server half is stripped before anything reaches the browser. The runs-twice
half never receives `request` or `response` — it also executes in a browser,
where neither exists — and is never `async`.

**A `.client.tsx` suffix is a naming convention, not an SSR-isolation boundary
in 5.2.** A module statically imported by a root, layout, page, or one of their
imports is still evaluated by the server. Top-level browser globals such as
`window` therefore crash SSR boot. Warlock 5.2 does not ship a client-only
component primitive; code that requires browser globals at module scope cannot
be part of the SSR page graph.

**Imported non-stylesheet static assets are also unsupported by the production
server build in 5.2.** An import such as `import logo from "./logo.svg"` works
under Vite in development but is refused by `warlock build`. Put the file under
the application's `public/` directory and reference its root URL instead:
`public/logo.svg` is `/logo.svg`. Stylesheet imports remain supported.

### Loader order

Loaders run **sequentially, root to leaf, each awaited before the next
starts**: the `root.tsx` App loader, then every matched layout loader from
outermost to innermost, then the page loader. The runtime has three top-level
slots (`app`, `layout`, `page`), but the layout slot composes the full matched
layout chain. Only one layout on that chain may render; loader-only and
middleware-only layouts still participate.

**The first core `Response` returned by a loader is terminal**: it stops every
lower loader from running, skips metadata, and is sent as-is. Because it is
returned whole, the buffered header and cookie writes made at that level go
with it — use `response.redirect()` / `response.notFound()` when you want those
writes committed, and a raw `Response` only when you mean exactly that
response.

### Environment variables

**`process.env` is refused entirely in the client/universal graph. There is no
`PUBLIC_` exception to it — static or computed — and `env("PUBLIC_X")` does not
work client-side either.** The supported pattern is to read the value in a page
loader, which is server code, and pass it to the page as loader data:

```tsx
import { env } from "@warlock.js/core";
import type { PageLoader, PageProps } from "@warlock.js/web";

export const loader = (async () => ({
  siteName: env("PUBLIC_SITE_NAME"),
})) satisfies PageLoader;

export default function HomePage({ data }: PageProps<typeof loader>) {
  return <h1>{data.siteName}</h1>;
}
```

The loader is server-only, so it may read configuration normally. Its return
value becomes page data and is serialized to the browser; return only values
that are safe to expose.

The refusal applies to default page and layout components, `register()`, and
any helper they import. It covers keyed reads (`process.env.X`,
`process.env.PUBLIC_X`, `process.env[key]`) and **bare value-reads** of the
object itself — `const { X } = process.env`, `{ ...process.env }`,
`Object.keys(process.env)`, `JSON.stringify(process.env)`. `process` does not
exist in a browser, so touching the object at all is already broken, and
handing the whole object to a component is how a server secret ships in one
line.

**Enforcement covers dev SSR as well as the client bundle, and a violation
fails the build** — this is not a production-only check you find out about
late. Server-side code is unrestricted.

If a value must genuinely be inlined into browser code rather than passed as
loader data, the one supported spelling is `import.meta.env.PUBLIC_*` with a
static key. That is Vite's surface, not Node's; it is baked in at build time,
so it cannot vary per request — loader data remains the answer for anything
request-scoped.

## Routing

A page's URL is its `route` export when it declares one. A page with no
`route` derives its URL from its own location beneath `src/web`: directories
contribute segments, `(group)` directories contribute nothing, `index.page.tsx`
claims its directory, and `[id]` becomes `:id`. A layout's `prefix` still
composes in front of either form. `route`, when present, always wins.

Every `*.page.tsx` must have a **default export**. A page file with only named
exports is a hard discovery/build failure naming the file — it used to build
and then serve a blank `200` at its URL.

**Catch-all routes are not supported.** `[...slug].page.tsx` is not a rest
parameter: only `[name]` is recognized as dynamic, so `[...slug]` is taken as a
literal segment and derives the unreachable path `/[...slug]`. Nothing warns
about it. Use a terminal wildcard with an explicit route
(`route = { path: "/docs/*" }`) until a real catch-all exists.

`src/web` is the only page root — a per-module `src/app/<module>/web/` tree is
not scanned.

Incoming URLs may carry one trailing slash: `/about` and `/about/` match the
same page in development and production. Route declarations remain canonical
and slash-free, `/` stays the root path, and case handling is unchanged.

Exactly two page filenames are special: `404.page.tsx` (the not-found page,
reached by not matching, never declares `route`, renders with no layout) and
`error.page.tsx` (the application's one error boundary, also declares no
`route`). There is no `500.page.tsx`; an unmatched URL is not an error.

**`404.page.tsx` never runs its own loader.** The module is registered and
rendered for real — `register()` and its middleware still run — but the page
loader is omitted from the request in both development and production, so a
missing URL cannot trigger application data work, redirect, or fail a second
time through the fallback. Layout loaders do not run either, because the page
has an empty layout chain by construction. The `root.tsx` App loader **does**
still run, so keep it cheap and make sure it tolerates a request that matched
nothing.

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
