---
name: use-layouts
description: 'Wrap pages with positional `layout.tsx` modules, compose literal `prefix` exports, load typed layout data with `LayoutLoader` / `LayoutProps`, and preserve layout state during client navigation. Triggers: `layout.tsx`, `prefix`, `LayoutLoader`, `LayoutProps`, `children`; "add a page layout", "share navigation between pages", "prefix page routes", "keep a layout mounted". Skip: full-document root — `@warlock.js/web/write-the-root/SKILL.md`; page route export — `@warlock.js/web/create-a-page/SKILL.md`; loader and shared lifecycle — `@warlock.js/web/load-page-data/SKILL.md`; competing layout systems `next/layout`, React Router outlets, Remix nested routes.'
---

# Warlock — use layouts

A positional `layout.tsx` applies to pages in its directory and descendant directories. Its default export wraps the page; its optional `prefix` contributes to every descendant page's effective URL.

## The shape

```tsx title="src/app/products/web/layout.tsx"
import type { LayoutLoader, LayoutProps } from "@warlock.js/web";

export const prefix = "/products";

export const loader = (async () => {
  return {
    navigation: [
      { href: "/products", label: "Products" },
      { href: "/products/new", label: "New product" },
    ],
  };
}) satisfies LayoutLoader;

export default function ProductsLayout({
  data,
  children,
}: LayoutProps<typeof loader>) {
  return (
    <section>
      <nav aria-label="Products">
        {data.navigation.map(item => (
          <a key={item.href} href={item.href}>
            {item.label}
          </a>
        ))}
      </nav>
      {children}
    </section>
  );
}
```

A page beside it can declare its path relative to the prefix:

```tsx title="src/app/products/web/index.page.tsx"
export const route = {
  path: "/",
  name: "products.index",
} as const;

export default function ProductsPage() {
  return <h1>Products</h1>;
}
```

The effective URL is `/products`. A page with `route.path = "/:id"` under the same layout is served at `/products/:id`.

## Prefix composition

Every positional layout on the page's directory ancestry may export a literal `prefix`. Prefixes compose outermost first, then the page's own route path.

```tsx title="src/app/users/web/layout.tsx"
export const prefix = "/users";
```

```tsx title="src/app/users/web/account/layout.tsx"
export const prefix = "/account";
```

```tsx title="src/app/users/web/account/settings.page.tsx"
export const route = {
  path: "/settings",
  name: "users.account.settings",
} as const;

export default function SettingsPage() {
  return <h1>Account settings</h1>;
}
```

This page's effective URL is `/users/account/settings`.

Like page routes, prefixes are read statically at build time. Write `export const prefix = "/account";` directly; computed prefixes are refused.

## Rendering-layout limit

Prefix nesting does not imply wrapper nesting. Pages currently support at most one rendering layout—one `layout.tsx` with a default export—on their ancestry path.

The two prefix-only layouts above are legal because neither renders. Add a default export to at most one of them. If two layouts on the path have default exports, discovery and boot throw `NestedLayoutsNotSupportedError`, naming the page and both rendering layouts.

Non-rendering layouts may carry prefixes and middleware and may nest freely. Do not delete a middleware-only authorization boundary to satisfy the rendering limit; consolidate only the default-export wrappers.

## Why layout state persists

Client navigation rebuilds the Layout + Page element tree at the same `#root` position. When the next page uses the same layout component type in the same position, React reconciles it instead of remounting it. Layout state such as open menus, scroll containers, and media survives.

`refresh()` has the same property: it re-fetches loaders and swaps the page data while the layout stays mounted. Navigating to a page with a different layout component changes the tree type and remounts that wrapper.

## Loader data

`LayoutLoader` receives the full `PageContext` and its return reaches `LayoutProps<typeof loader>["data"]`. Layout, App, and Page loaders run in parallel; a layout loader cannot read the page loader's result.

Use `shared` when multiple levels need one request-derived value, and write it in middleware before loaders run. See [load-page-data](../load-page-data/SKILL.md).

## Gotchas

- **`layout.tsx` is positional.** It applies by directory ancestry; moving a page can change its layout and URL prefix together.
- **Only one layout on a path may render.** Multiple prefix/middleware-only layouts are fine; multiple default exports are not.
- **A layout prefix changes the registered URL.** Check the composed path, not only the page's `route.path`.
- **Keep `prefix` literal.** The build parses it without executing the module.
- **Use `LayoutProps<typeof loader>`.** Bare `LayoutProps` is for a layout with no loader and gives `data` as `undefined`.
- **Layout persistence is type-and-position based.** Changing to another layout component remounts it, as normal React reconciliation requires.

## See also

- [`create-a-page/SKILL.md`](../create-a-page/SKILL.md) — declare the page path composed after the prefix.
- [`write-the-root/SKILL.md`](../write-the-root/SKILL.md) — the document and `#root` outside the layout.
- [`load-page-data/SKILL.md`](../load-page-data/SKILL.md) — `LayoutLoader`, parallel execution, and `shared`.
- [`navigate-on-the-client/SKILL.md`](../navigate-on-the-client/SKILL.md) — client swaps and `refresh()`.
