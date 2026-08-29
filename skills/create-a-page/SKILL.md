---
name: create-a-page
description: 'Create an SSR React page under `src/web/**`, with either a literal `route` or a filesystem-derived one, a default component, an optional typed `loader`, page `metadata`, the `error.page.tsx` boundary, and the universal `register()` hook. Triggers: `*.page.tsx`, `route`, `PageLoader`, `PageProps`, `PageMetadata`, `error.page.tsx`, `register`; "create a page", "add an SSR route", "make a React page", "type page loader data", "add an error boundary"; typical import `import type { PageLoader, PageProps } from "@warlock.js/web"`. Skip: root document shell — `@warlock.js/web/write-the-root/SKILL.md`; layout wrappers and prefixes — `@warlock.js/web/use-layouts/SKILL.md`; loader lifecycle and `shared` — `@warlock.js/web/load-page-data/SKILL.md`; competing frameworks `next`, `remix`, `react-router` file routes.'
---

# Warlock — create a page

A page is any `*.page.tsx` beneath `src/web/` — the only page root. (A per-module `src/app/<module>/web/` tree is not scanned; move any page that lived there into `src/web/`, a subdirectory if you like.) Its URL is either a declared `route` or one derived from its own location; its default export renders React.

## The shape

```tsx title="src/web/products/product-details.page.tsx"
import type { PageLoader, PageMetadata, PageProps } from "@warlock.js/web";

export const route = {
  path: "/products/:id",
  name: "products.details",
} as const;

export const loader = (async ({ request, response }) => {
  const id = request.input("id");

  response.header("cache-control", "private, max-age=60");

  return {
    product: {
      id,
      name: `Product ${id}`,
    },
  };
}) satisfies PageLoader<undefined, typeof route>;

export const metadata: PageMetadata<typeof loader> = ({ data }) => ({
  title: data.product.name,
  description: `Details for ${data.product.name}`,
});

export default function ProductDetailsPage({ data }: PageProps<typeof loader>) {
  return (
    <main>
      <h1>{data.product.name}</h1>
      <p>Product id: {data.product.id}</p>
    </main>
  );
}
```

Use `satisfies PageLoader`, not `: PageLoader`. `satisfies` checks the context contract while retaining the loader's concrete return type, which is how `PageProps<typeof loader>` knows the shape of `data`.

## The minimum page

```tsx title="src/web/contact.page.tsx"
export const route = "/contact";

export default function ContactPage() {
  return (
    <main>
      <h1>Contact</h1>
      <a href="mailto:support@example.com">support@example.com</a>
    </main>
  );
}
```

`route` is optional. A page that omits it derives both its path and its name from where the file sits beneath `src/web` ([filesystem routing](#filesystem-routing), below). A page that declares `route` uses that instead — an explicit `route` always wins over the derived one, for both the path and (when it sets `name`) the name.

Changed in 5.2: through 5.1 an omitted `route` was refused — `warlock dev` and the production discovery pass threw `MissingRouteExportError`, naming the file. That error class is gone; the same file now resolves to a real, browsable URL.

## Route declarations

Use either a bare path or a literal object:

```ts
export const route = "/products";
```

```ts
export const route = {
  path: "/products/:id",
  name: "products.details",
} as const;
```

Prefer an explicit stable `name` for links. Without one, Warlock derives a name from the declared path — a global root page gets `index`, another global page gets its dotted path — the same derivation [filesystem routing](#filesystem-routing) uses when there is no `route` at all.

Every segment of a page's URL is written down somewhere: `route.path` (or the derived filesystem path), prefixed by the literal `prefix` exports of the positional layouts above it ([use-layouts](../use-layouts/SKILL.md)). Where the file sits always decides which layouts are above it, and — only when `route` is absent — the path segments too.

The build reads `route` without executing application code. Declare it directly with `export const` and literal strings. Variables, function calls, computed object keys, spreads, and `export { route }` are refused.

## Filesystem routing

Omit `route` and the URL comes from the page's own path beneath `src/web`:

- Every directory contributes a segment, in order — `src/web/products/featured.page.tsx` derives `/products/featured`.
- A `(group)` directory — parentheses, not braces — contributes nothing to the URL, only to organization: `src/web/(marketing)/pricing.page.tsx` derives `/pricing`.
- `index.page.tsx` claims its own directory rather than adding a segment: `src/web/products/index.page.tsx` derives `/products`. This is the ONLY filename with special meaning — `home.page.tsx` is not magic and derives `/home`.
- `[id]` becomes `:id`: `src/web/products/[id].page.tsx` derives `/products/:id`.
- A layout `prefix` on the page's ancestry composes in front of the derived path exactly as it does for an explicit `route.path` ([use-layouts](../use-layouts/SKILL.md)).

Two pages that derive (or declare) the same effective path is a build error naming both files.

## Page-route grammar

Page routes deliberately accept less than API routes:

- Supported: `/`, static segments, whole-segment params such as `/products/:id`, the exact wildcard `*`, and a terminal wildcard such as `/docs/*`.
- Not supported: regex params, optional params, multiple params in one segment, params mixed with text, doubled or trailing slashes, and non-terminal wildcards.

Write two pages for an optional segment. Validate a constrained parameter in the page instead of putting a regex in its path.

## Metadata

`metadata` may be a static object or a function of the resolved loader data and readonly `shared` payload:

```tsx
import type { PageMetadata } from "@warlock.js/web";

export const metadata: PageMetadata = {
  title: "Products",
  description: "Browse the product catalogue",
  robots: "index,follow",
  openGraph: {
    type: "website",
    image: "/images/catalogue-card.png",
  },
};
```

Supported fields are `title`, `description`, `keywords`, `canonical`, `robots`, `openGraph`, and `twitter`. Function metadata runs after a successful loader. If a loader fails, Warlock uses error metadata instead of calling the page function with missing data.

## The error boundary — `error.page.tsx`

`error.page.tsx` anywhere beneath `src/web` is the application's one error boundary — exactly two page filenames are special in Warlock, this and `404.page.tsx`. A second `error.page.tsx` is a build error naming both files. Like `404.page.tsx`, it declares no `route` — it has no URL of its own and is reached only when something throws.

```tsx title="src/web/error.page.tsx"
import type { ErrorPageProps } from "@warlock.js/web";

export default function ErrorPage({ error, status }: ErrorPageProps) {
  return (
    <main>
      <h1>Something went wrong</h1>
      <p>Status: {status}</p>
    </main>
  );
}
```

During SSR the component receives the real thrown value in `error`. After hydration it receives the JSON-safe `{ name, message, stack? }` shape instead — the original value does not survive the wire. `robots: noindex` is a framework default on this path that an app-supplied `metadata` cannot remove.

If the failure happens before any page module could even load — a module-load or `register()` throw — there is no trustworthy server composition left to hydrate against, so Warlock renders a plain framework fallback (your `error.page.tsx` if it can still be loaded, otherwise a minimal built-in boundary) with no hydration script at all rather than risk hydrating client code against markup nothing can vouch for.

## The `register()` hook

`root.tsx`, `layout.tsx`, and `*.page.tsx` may each export `register`: a synchronous, no-argument, side-effect hook that runs once per module namespace instance, on both the server and the browser, before that module's middleware or loader. Unlike `route`/`middleware`/`validation`/`loader`/`metadata`, it is not stripped from the client — it is meant to run on both sides.

```tsx
export function register() {
  // one-time setup for this module namespace; must not return a Promise
}
```

Returning a Promise (or anything thenable) throws — `register()` must finish before the module is usable.

## The client boundary

The browser boundary is decided by the import graph, not by the file's location. A `*.page.tsx` is universal:

- `route`, `middleware`, `validation`, `loader`, and `metadata` are stripped from the client projection.
- The default component and any other surviving exports form the client graph.
- An import used only by a stripped server export is removed with it.
- An import also used by the component survives and therefore must be browser-safe.

Keep server-only repository and service reads inside `loader`. Do not read them from module-scope initializers or the default component.

## Editing a page in development

`warlock dev` decides Fast Refresh vs. a full reload by comparing the module's *skeleton* — its source with every component body masked out — across the edit. Everything outside a component body is part of the skeleton: imports, module-level declarations, and all server exports (`route`, `middleware`, `validation`, `loader`, `metadata`). The skeleton moving, with or without a simultaneous JSX change, forces a full reload; the skeleton holding still defers to Fast Refresh.

- **A JSX-only edit hot-updates.** The skeleton is unchanged, so Vite's Fast Refresh applies the projected client code with no reload and no lost component state.
- **A `metadata`-only edit reloads the document.** `metadata` sits outside the skeleton's masked region, so the edit moves it. Warlock sends a full reload, which re-runs SSR and rebuilds `<head>`. Component state is lost — that is the price of seeing the new `<title>` without touching the browser.
- **Any module-level change reloads, not just `metadata`.** An edited import, a module-level declaration, or an edit confined to `route`, `middleware`, `validation`, or `loader` all move the skeleton the same way and take the same full-reload path.
- **A helper function used only by the JSX still reloads if it is declared at module level.** The rule does not try to prove which half of a shared declaration the edit was "really" for — it over-approximates deliberately, because a false reload only costs component state, while a missed one ships a stale `<head>` and calls it a hot update.
- Creating, deleting, or renaming a page file, or editing its `route` export, is page-GRAPH churn, not a skeleton edit — see below, not Fast Refresh.

Changed in 5.1: a metadata-only edit previously left a stale `<head>` until you refreshed the browser by hand. The current skeleton-comparison rule replaces that earlier, narrower "metadata-only" special case.

## Route-table changes in development

Creating a page, deleting one, or editing its `route` export's path is a different kind of dev edit from the skeleton comparison above — it changes which URLs exist, not just how one already-registered URL renders. `warlock dev` re-registers the affected route(s) in the live route table, atomically and with no dev-server restart, so the new file (or new path) is reachable on the very next request with no manual restart.

Changed in 5.2: through 5.1 the route table was built once at boot and never again. Creating a page 404'd forever; deleting one kept it reachable at its old URL; editing `route` served the OLD path from the old file and 404'd the new one — the running server silently disagreed with the source on disk. All three are now live.

## Gotchas

- **A page with no `route` is not unreachable.** It derives a real URL from its file location — see [Filesystem routing](#filesystem-routing). Nothing about a route-less page is refused anymore.
- **Keep `route` literal.** A computed route cannot be discovered without executing app code and is refused.
- **Do not annotate the loader with `: PageLoader`.** That erases the return type `PageProps` needs.
- **Components receive data, not HTTP objects.** `request` and `response` belong to loaders; the component also renders in the browser.
- **A default component is synchronous.** Fetch in the loader, then render its result.
- **There are no server actions.** Mutations remain ordinary API requests; call `refresh()` after a successful mutation.
- **Do not import the hydration entry.** `esm/hydration/index.mjs` is a framework build input, not a consumer API. The public low-level runtime subpath is `@warlock.js/web/client/runtime`.

## See also

- [`load-page-data/SKILL.md`](../load-page-data/SKILL.md) — validation, loader context, response short-circuits, and `shared`.
- [`use-layouts/SKILL.md`](../use-layouts/SKILL.md) — positional layouts, prefixes, and persistence.
- [`navigate-on-the-client/SKILL.md`](../navigate-on-the-client/SKILL.md) — `Link`, `href`, navigation, and `refresh()`.
- [`serve-styles/SKILL.md`](../serve-styles/SKILL.md) — CSS imports in page and root modules.
