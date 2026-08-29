---
name: load-page-data
description: 'Load App, Layout, and Page data with `AppLoader`, `LayoutLoader`, and `PageLoader`; type component `data`, validate page input, short-circuit with the buffered response, and publish request-scoped browser-safe values through `shared`. Triggers: `PageLoader`, `LayoutLoader`, `AppLoader`, `PageProps`, `shared`, `useShared`, `validation`, `request.validated`; "load page data", "pass server data to React", "share request data", "redirect from a loader". Skip: page module basics — `@warlock.js/web/create-a-page/SKILL.md`; layouts — `@warlock.js/web/use-layouts/SKILL.md`; mutation follow-up — `@warlock.js/web/navigate-on-the-client/SKILL.md`; competing loaders Next data functions, Remix loaders, React Server Components.'
---

# Warlock — load page data

Loaders run on the server and return serializable data to their own component level. Use the level-specific loader type with `satisfies`, then pass `typeof loader` to the matching props type.

## The shape

```tsx title="src/web/products/product-details.page.tsx"
import { v } from "@warlock.js/seal";
import type { PageLoader, PageProps } from "@warlock.js/web";

export const route = {
  path: "/products/:id",
  name: "products.details",
} as const;

export const validation = {
  schema: v.object({
    id: v.string().minLength(2),
  }),
  validating: ["params"],
} as const;

export const loader = (async ({ request, response, shared }) => {
  const { id } = request.validated();

  if (id === "missing") {
    return response.notFound();
  }

  response.header("cache-control", "private, max-age=60");

  return {
    product: {
      id,
      name: `Product ${id}`,
    },
    locale: (shared as { locale?: string }).locale ?? "en",
  };
}) satisfies PageLoader<typeof validation, typeof route>;

export default function ProductDetailsPage({ data }: PageProps<typeof loader>) {
  return (
    <article lang={data.locale}>
      <h1>{data.product.name}</h1>
    </article>
  );
}
```

`LoaderShortCircuit` values from `notFound()` and redirects are excluded from `PageProps["data"]`, so the component sees only the successful loader return.

## Three loader levels

| Module | Contract | Component props |
| --- | --- | --- |
| `src/web/root.tsx` | `AppLoader` | `AppProps<typeof loader>` |
| positional `layout.tsx` | `LayoutLoader` | `LayoutProps<typeof loader>` |
| `*.page.tsx` | `PageLoader` | `PageProps<typeof loader>` |

All receive one context object with `request`, `response`, and `shared`. Page loaders add generics that connect their sibling `validation` and `route` exports to `request.validated()` and `request.input()`.

## Validation

A page's `validation` export has:

- `schema`: a Seal validator.
- `validating`: any ordered subset of `"body"`, `"query"`, `"params"`, and `"headers"`.

When `validating` is absent or empty, pages validate query + params, with params winning a duplicate key. Validation runs before loaders and a failure short-circuits with 422.

`request.validated()` uses the schema's output type, so fields with `.default(...)` are present. `request.input("id")` is narrowed from a literal route path when the loader uses `typeof route`.

## Loader response surface

Each loader gets its own buffered response because App, Layout, and Page loaders execute in parallel. The public loader methods are:

```ts
response.header("cache-control", "private, max-age=60");
response.setStatusCode(201);
return response.redirect("/login");
return response.permanentRedirect("/products");
return response.notFound();
```

Do not continue after a redirect or `notFound`; return the result. Surviving buffers are committed root to leaf. For the same header key, the leafward write wins. A loader that throws or a lower level discarded by a short-circuit does not leak its buffered writes.

## Declare the shared payload

`SharedContext` ships empty and has no index signature. Augment it once with everything the browser is allowed to receive:

```ts title="src/web/types.ts"
declare module "@warlock.js/web" {
  interface SharedContext {
    locale: string;
    user?: {
      name: string;
    };
  }
}

export {};
```

Required keys need an unconditional middleware writer. Optional keys may be written conditionally:

```tsx title="src/web/root.tsx"
import { Head, Scripts, shared as writableShared } from "@warlock.js/web";
import type { AppProps } from "@warlock.js/web";
import "./types";

const publishLocale = async () => {
  writableShared.locale = "en";
};

export const middleware = [publishLocale];

export default function App({ children, shared }: AppProps) {
  return (
    <html lang={shared.locale}>
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

## Shared lifecycle

`shared` looks global but resolves through the current request's store on every access. Two requests never share its target.

The request pipeline is:

1. App, layout, and page middleware run outermost first and write `shared`.
2. `shared` is normalized, checked, and sealed.
3. App, layout, and page loaders run in parallel and may only read it.
4. Components receive a readonly snapshot through props or `useShared()`.

Use `useShared()` in a deep component that is not already receiving level props:

```tsx title="src/web/components/locale-label.tsx"
import { useShared } from "@warlock.js/web";

export function LocaleLabel() {
  const shared = useShared();

  return <span>Locale: {shared.locale}</span>;
}
```

Only put browser-safe data in `shared`: scalars, arrays, plain objects, or values with a valid `toJSON()` contract. Functions, `Date`, `Map`, `Set`, and arbitrary class instances are rejected. Prefer a narrow Resource output over a model.

## Parallelism rules

- App, Layout, and Page loaders cannot read each other's return values.
- A loader may read `shared` because middleware completed and it was sealed first.
- A loader must not write `shared`; a post-seal write throws.
- Loader response mutations are buffered per level and settled deterministically.

## Gotchas

- **Use `satisfies`, not a type annotation.** Preserve the return type for component props.
- **Return client-safe data.** Components render again in the browser; models and server handles do not survive the wire.
- **Write `shared` in middleware only.** Loaders run after the seal.
- **Required shared keys need unconditional writers.** The type is a promise for every request.
- **Do not use loader return values as cross-level communication.** The loaders run in parallel.
- **Server actions are not supported.** POST to an ordinary Warlock API route and call `refresh()` after success.

## See also

- [`create-a-page/SKILL.md`](../create-a-page/SKILL.md) — the complete page module.
- [`write-the-root/SKILL.md`](../write-the-root/SKILL.md) — `AppLoader`, `<Head />`, and `<Scripts />`.
- [`use-layouts/SKILL.md`](../use-layouts/SKILL.md) — `LayoutLoader` and persistent wrappers.
- [`navigate-on-the-client/SKILL.md`](../navigate-on-the-client/SKILL.md) — re-fetch loaders with `refresh()`.
