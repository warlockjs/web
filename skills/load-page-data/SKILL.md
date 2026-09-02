---
name: load-page-data
description: 'Load App, Layout, and Page data with `AppLoader`, `LayoutLoader`, and `PageLoader`; type component `data`, validate page input, short-circuit with the buffered response, and publish request-scoped browser-safe values through `shared`. Triggers: `PageLoader`, `LayoutLoader`, `AppLoader`, `PageProps`, `shared`, `useShared`, `validation`, `request.validated`, `process.env`, `env("PUBLIC_...")`, `import.meta.env.PUBLIC_`; "load page data", "pass server data to React", "share request data", "redirect from a loader", "read an environment variable in a page", "process.env refused in the client build", "loader execution order", "return a Response from a loader". Skip: page module basics — `@warlock.js/web/create-a-page/SKILL.md`; layouts — `@warlock.js/web/use-layouts/SKILL.md`; mutation follow-up — `@warlock.js/web/navigate-on-the-client/SKILL.md`; competing loaders Next data functions, Remix loaders, React Server Components.'
---

# Warlock — load page data

Loaders run on the server and return serializable data to their own component level. Use the level-specific loader type with `satisfies`, then pass `typeof loader` to the matching props type.

## Pass environment values through loader data

**`process.env` is refused outright in the client/universal graph, and there is
no `PUBLIC_` exception to it — static or computed.** `env("PUBLIC_X")` does not
work client-side either. **The supported pattern is: read the value in a loader,
which is server code, and return it as page data.**

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

Loaders are server-only and may read configuration normally. Their return is
serialized to the browser, so include only values that are safe to expose.

### What is refused, and where

Every one of these fails the build when it is reachable from a default page or
layout component, `register()`, or any helper they import:

```tsx
process.env.API_URL; // static key — refused
process.env.PUBLIC_API_URL; // a PUBLIC_ prefix changes nothing — refused
process.env[key]; // computed key — refused
const { API_URL } = process.env; // bare value-read — refused
const all = { ...process.env }; // bare value-read — refused
Object.keys(process.env); // bare value-read — refused
JSON.stringify(process.env); // bare value-read — refused
env("PUBLIC_API_URL"); // pulls in @warlock.js/core, a server package — refused
```

Bare value-reads matter as much as keyed ones: `process` does not exist in a
browser, so referencing the object at all — assigned, destructured, spread, or
passed as an argument — is already broken, and passing the whole object to a
component is how a server secret reaches a page in one line.

**Enforcement covers dev SSR as well as the client bundle, and a violation
fails the build.** It is not a production-only check you can discover late: the
same refusal fires under `warlock dev`.

Reads inside `loader`, `route`, `middleware`, `validation`, and `metadata` are
never affected — those exports are stripped before the client graph is formed.
Server-side code is unrestricted.

### The one client-side escape hatch

If a value genuinely has to be inlined into browser code rather than passed
through loader data, the supported spelling is `import.meta.env.PUBLIC_*` with a
**static** key:

```tsx
export default function HomePage() {
  return <h1>{import.meta.env.PUBLIC_SITE_NAME}</h1>;
}
```

`import.meta.env` is the Vite surface, not Node's, and only the `PUBLIC_` prefix
(plus Vite's own `MODE`, `DEV`, `PROD`, `BASE_URL`, `SSR`) is allowed through. It
is inlined at build time, so it cannot vary per request or per deployment of the
same bundle — which is why loader data remains the default answer, and the only
one for anything request-scoped.

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

| Module                  | Contract       | Component props              |
| ----------------------- | -------------- | ---------------------------- |
| `src/web/root.tsx`      | `AppLoader`    | `AppProps<typeof loader>`    |
| positional `layout.tsx` | `LayoutLoader` | `LayoutProps<typeof loader>` |
| `*.page.tsx`            | `PageLoader`   | `PageProps<typeof loader>`   |

All receive one context object with `request`, `response`, and `shared`. Page loaders add generics that connect their sibling `validation` and `route` exports to `request.validated()` and `request.input()`.

## Validation

A page's `validation` export has:

- `schema`: a Seal validator.
- `validating`: any ordered subset of `"body"`, `"query"`, `"params"`, and `"headers"`.

When `validating` is absent or empty, pages validate query + params, with params winning a duplicate key. Validation runs before loaders and a failure short-circuits with 422.

`request.validated()` uses the schema's output type, so fields with `.default(...)` are present. `request.input("id")` is narrowed from a literal route path when the loader uses `typeof route`.

## Execution order

Loaders run **sequentially, root to leaf, each one awaited before the next starts**: `root.tsx`'s `AppLoader`, then every matched `LayoutLoader` from outermost to innermost, then the page's `PageLoader`. The runtime has three top-level slots (`app`, `layout`, `page`), but the layout slot composes the full matched layout chain. A page may have only one _rendering_ layout; prefix-, middleware-, and loader-only layouts may still appear at multiple ancestry levels.

**The first core `Response` a loader returns is terminal.** Returning a `Response` object stops the pipeline immediately: no lower loader starts, `metadata` is not resolved, and that response is sent as-is. It is more terminal than a short-circuit — because the response is returned whole, the buffered header/cookie writes made at that same level are discarded along with everything below it. Use `response.redirect()` / `response.notFound()` (which produce a `LoaderShortCircuit`, committing that level's buffer inclusively) when you want your buffered writes to survive; return a raw `Response` only when you mean "this exact response, nothing else."

A loader that **throws** is also terminal: it stops lower loaders, discards its own level's buffer, and commits only the levels above it.

## Loader response surface

Each loader gets its own buffered response — never the live one — so that a level discarded by a short-circuit or a throw cannot leak half-written headers onto a response it no longer owns. The public loader methods are:

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
3. App, layout, and page loaders run in order, root to leaf, and may only read it.
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

## Level isolation rules

- App, Layout, and Page loaders cannot read each other's return values. They run in order, but no channel is provided between them — a lower loader is not handed what an upper one returned. Put anything a lower level needs into `shared` from middleware instead.
- A loader may read `shared` because middleware completed and it was sealed first.
- A loader must not write `shared`; a post-seal write throws.
- Loader response mutations are buffered per level and settled deterministically, root to leaf.

## Gotchas

- **Use `satisfies`, not a type annotation.** Preserve the return type for component props.
- **Return client-safe data.** Components render again in the browser; models and server handles do not survive the wire.
- **Write `shared` in middleware only.** Loaders run after the seal.
- **Required shared keys need unconditional writers.** The type is a promise for every request.
- **Do not use loader return values as cross-level communication.** Levels run in order but are not wired to each other; use `shared`, written in middleware.
- **`404.page.tsx` never runs its own loader.** The not-found page's module is registered and rendered for real — `register()` and its middleware still run — but the page loader is omitted from the request in both dev and production, so a missing URL cannot trigger application data work or fail a second time. Its ancestry contributes nothing either: the 404 page renders with an empty layout chain by construction. **The root `AppLoader` in `root.tsx` still runs** for a 404 request, so keep it cheap and make sure it tolerates a request that matched nothing.
- **`process.env` is refused in the client/universal graph, with no `PUBLIC_` exception.** Read it in a loader and return it as page data.
- **Server actions are not supported.** POST to an ordinary Warlock API route and call `refresh()` after success.

## See also

- [`create-a-page/SKILL.md`](../create-a-page/SKILL.md) — the complete page module.
- [`write-the-root/SKILL.md`](../write-the-root/SKILL.md) — `AppLoader`, `<Head />`, and `<Scripts />`.
- [`use-layouts/SKILL.md`](../use-layouts/SKILL.md) — `LayoutLoader` and persistent wrappers.
- [`navigate-on-the-client/SKILL.md`](../navigate-on-the-client/SKILL.md) — re-fetch loaders with `refresh()`.
