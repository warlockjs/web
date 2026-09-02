---
name: navigate-on-the-client
description: 'Navigate hydrated pages with `<Link>`, resolve named URLs with `href()`, use `navigateTo` / `navigateBack`, prefetch on interaction, inspect the server match with `currentRoute()`, and re-fetch loaders after a mutation with `refresh()`. Triggers: `Link`, `href`, `navigateTo`, `navigateBack`, `refresh`, `currentRoute`, `previousRoute`; "navigate without a reload", "link to a named route", "refresh page data", "revalidate loaders", "client-side back"; typical import `import { Link, refresh } from "@warlock.js/web"`. Skip: define a page route — `@warlock.js/web/create-a-page/SKILL.md`; loader mechanics — `@warlock.js/web/load-page-data/SKILL.md`; root hydration boundary — `@warlock.js/web/write-the-root/SKILL.md`; competing routers `@mongez/react-router`, `react-router-dom`, Next navigation.'
---

# Warlock — navigate on the client

`<Link>` renders a real anchor for progressive enhancement and intercepts a plain in-app click after hydration. The server remains the only route matcher; client navigation fetches the page-data representation of the URL and swaps the Layout + Page tree.

Every behaviour on this page depends on hydration having mounted. See [write-the-root](../write-the-root/SKILL.md#root-is-the-hydration-boundary).

## The shape

```tsx title="src/web/components/product-link.tsx"
import { Link } from "@warlock.js/web";

export function ProductLink({ id }: { id: string }) {
  return (
    <Link
      to="products.details"
      params={{ id }}
      query={{ tab: "specifications" }}
      prefetch
    >
      View product
    </Link>
  );
}
```

Route-name destinations resolve through the table published from the same page graph the server installs. Missing or extra params throw rather than producing a URL that silently 404s.

## Link destinations

Pass exactly one destination prop:

```tsx
import { Link } from "@warlock.js/web";

export function NavigationLinks() {
  return (
    <nav>
      <Link to="products.index">Products</Link>
      <Link href="/pricing">Pricing</Link>
      <Link href="https://example.com/docs" newTab>External docs</Link>
      <Link email="sales@example.com">Email sales</Link>
      <Link tel="+201000000000">Call sales</Link>
    </nav>
  );
}
```

`to` and `href` both accept a route name or literal URL:

- A value beginning with `/` or with a URI scheme is literal and is passed through.
- Any other value is a route name and is resolved through `href()`.
- `params` and `query` apply only to route names.
- `newTab` supplies `_blank` and `noopener noreferrer` unless you provide your own `target` or `rel`.

`prefetch` fetches in-app page data on hover or keyboard focus. It is ignored for external, email, telephone, new-tab, and explicitly targeted links. Prefetch is best-effort and never delays the interaction.

Modified clicks, middle clicks, downloads, another browsing context, or an earlier `preventDefault()` remain browser-owned.

## Build a URL without React

`href(name, params?, query?)` is the durable primitive for redirects, headers, email bodies, and other non-component callers:

```ts
import { href } from "@warlock.js/web";

const productUrl = href(
  "products.details",
  { id: "42" },
  { tab: "reviews", tags: ["featured", "sale"] },
);
```

Unknown route names throw at runtime with the known names. Call `href()` after the route table has been published—during a page render, event, or request—not from an eager module initializer before boot.

## Programmatic navigation

```tsx title="src/web/components/checkout-button.tsx"
import { href, navigateBack, navigateTo } from "@warlock.js/web";

export function CheckoutButtons() {
  const openCheckout = () => {
    const url = href("checkout.index");

    if (!navigateTo(url)) {
      window.location.assign(url);
    }
  };

  return (
    <div>
      <button type="button" onClick={navigateBack}>Back</button>
      <button type="button" onClick={openCheckout}>Checkout</button>
    </div>
  );
}
```

`navigateTo(path, { replace?: boolean })` accepts a path, not a route name. Resolve a name with `href()` first. It returns `false` when no client runtime accepted the navigation; use a real browser navigation when arrival is mandatory. `navigateBack()` is a no-op without a browser.

## Re-fetch after a mutation

The public primitive is `refresh()`. There is no `revalidate()` export.

```tsx title="src/web/products/delete-product-button.tsx"
import { refresh } from "@warlock.js/web";

export function DeleteProductButton({ id }: { id: string }) {
  const deleteProduct = async () => {
    const response = await fetch(`/api/products/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      throw new Error(`Delete failed with status ${response.status}`);
    }

    const refreshed = await refresh();

    if (!refreshed) {
      window.location.reload();
    }
  };

  return <button type="button" onClick={deleteProduct}>Delete product</button>;
}
```

`refresh()` re-fetches the current URL's App, Layout, and Page loaders and swaps fresh data without pushing history. It returns `true` only when fresh data reached the screen. On network/build failure it returns `false` and leaves the current page intact.

This is an ordinary API mutation followed by a re-fetch. Server actions are not supported.

## Current and previous routes

`currentRoute()` and `previousRoute()` report route names and params sent by the server; they never re-match the browser URL.

```tsx title="src/web/components/current-product-id.tsx"
import { currentRoute, previousRoute } from "@warlock.js/web";

export function CurrentProductId() {
  const current = currentRoute();
  const previous = previousRoute();

  return (
    <dl>
      <dt>Current product</dt>
      <dd>{current?.params?.id ?? "none"}</dd>
      <dt>Previous page</dt>
      <dd>{previous?.name ?? "first visit"}</dd>
    </dl>
  );
}
```

`previousRoute()` means the previously swapped page, not the previous browser-history entry. On the first page it is `undefined`.

`routerEvents` is exported and `refresh()` emits its start/end/error lifecycle today. Ordinary Link and `navigateTo` swaps are not yet wired to that emitter, so do not use it as a complete global navigation progress signal yet.

## Failure behavior

- A failed navigation falls back to a full browser load so the user still arrives.
- A failed `refresh()` keeps the current page and reports `false`; it never spends the page the user already has.
- Back/Forward uses the same data fetch and tree swap, replacing the existing history entry rather than pushing another.
- Navigating within one layout preserves layout state through React reconciliation.

## Gotchas

- **Use `refresh()`, not `revalidate()`.** `refresh` is the exported loader re-fetch primitive.
- **`navigateTo` accepts a URL/path.** Resolve named routes with `href()` first.
- **Pass exactly one Link destination.** Combining `to`, `href`, `email`, or `tel` throws.
- **Do not add `params` or `query` to a literal URL.** Put them in the URL itself or use a route name.
- **Do not build a client matcher.** The server's matched name and params travel in the payload.
- **Do not import `esm/hydration/index.mjs`.** Normal consumers import navigation from `@warlock.js/web`; low-level runtime contracts live at `@warlock.js/web/client/runtime`.

## See also

- [`create-a-page/SKILL.md`](../create-a-page/SKILL.md) — declare route names and params.
- [`load-page-data/SKILL.md`](../load-page-data/SKILL.md) — what `refresh()` re-runs.
- [`use-layouts/SKILL.md`](../use-layouts/SKILL.md) — why layout state persists.
- [`write-the-root/SKILL.md`](../write-the-root/SKILL.md) — the `#root` swap boundary.
