---
name: create-a-page
description: 'Create an SSR React page under `src/web/**` or `src/app/<module>/web/**` with a literal `route`, a default component, an optional typed `loader`, and page `metadata`. Triggers: `*.page.tsx`, `route`, `PageLoader`, `PageProps`, `PageMetadata`; "create a page", "add an SSR route", "make a React page", "type page loader data"; typical import `import type { PageLoader, PageProps } from "@warlock.js/web"`. Skip: root document shell — `@warlock.js/web/write-the-root/SKILL.md`; layout wrappers and prefixes — `@warlock.js/web/use-layouts/SKILL.md`; loader lifecycle and `shared` — `@warlock.js/web/load-page-data/SKILL.md`; competing frameworks `next`, `remix`, `react-router` file routes.'
---

# Warlock — create a page

A page is any `*.page.tsx` beneath the global `src/web/` tree or a module's `src/app/<module>/web/` tree. Its URL is declared by `route`; its default export renders React.

## The shape

```tsx title="src/app/products/web/product-details.page.tsx"
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

The `route` export is required, and a page without one is **refused, not skipped**. `warlock dev` and the production discovery pass throw the same `MissingRouteExportError`, naming the file, because a page with no route is a page nothing can ever reach.

Changed in 5.1: through 5.0.2 the dev server silently skipped a route-less page, so the file you had just written 404'd with nothing said. Dev and build now reach the same verdict from the same condition.

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

Prefer an explicit stable `name` for links. Without one, Warlock derives a name from the module and declared path: a module page gets `<module>.<path-as-dots>`, a global root page gets `index`, and another global page gets its dotted path.

**Only the route NAME is ever derived — never the route PATH.** There is no filename-to-URL convention in Warlock and there never has been. Omitting `route` does not fall back to the file's location; it fails (see above). Every segment of a page's URL is written down somewhere: the page's own `route.path`, prefixed by the literal `prefix` exports of the positional layouts above it ([use-layouts](../use-layouts/SKILL.md)). Where the file sits decides which layouts are above it — never what the path spells.

The build reads `route` without executing application code. Declare it directly with `export const` and literal strings. Variables, function calls, computed object keys, spreads, and `export { route }` are refused.

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
- Creating or deleting a page file is page-graph churn, not an in-place edit; Vite handles it on its own.

Changed in 5.1: a metadata-only edit previously left a stale `<head>` until you refreshed the browser by hand. The current skeleton-comparison rule replaces that earlier, narrower "metadata-only" special case.

## Gotchas

- **Do not expect URLs to be derived from filenames.** No such convention exists. The file's location chooses discovery and which layout prefixes apply; `route` chooses the rest of the public URL. A page with no `route` is refused, not mounted at its path.
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
