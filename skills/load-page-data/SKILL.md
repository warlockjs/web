---
name: load-page-data
description: "Load App, Layout, and Page data with named loaders; page validation and middleware belong in `config`. Also how loader data is typed on the page (`Serialized` on the devalue wire). Triggers: `PageLoader`, `LayoutLoader`, `AppLoader`, `PageProps`, `Serialized`, `ModelResourceRegistry`, `config.validation`, `config.middleware`, `request.validated`, `shared`, `response.cookie`, `response.clearCookie`, `response.redirect`, `response.notFound`."
---

# Warlock — load page data

Loaders run on the server and return serializable data to their own component level.
Declare the loader so TypeScript infers its return type, then pass `typeof loader`
to the matching props type (`PageProps<typeof loader>`). Two spellings do that, and
this skill uses both:

```tsx
// Either: a named function, with the context typed on the parameter.
export async function loader({ request }: PageLoaderContext<typeof config.validation, typeof config.route>) {
  return { id: request.validated().params.id };
}

// Or: an arrow function checked with `satisfies`; the context is typed from PageLoader.
export const loader = (async ({ request }) => {
  return { id: request.validated().params.id };
}) satisfies PageLoader<typeof config.validation, typeof config.route>;
```

Never annotate the loader itself as `export const loader: PageLoader = ...`.
`PageLoader` returns `unknown`, so the annotation replaces the inferred return type
and `data` in `PageProps<typeof loader>` loses its shape.

## Pass environment values through loader data

**`process.env` is refused outright in the client/universal graph, and there is
no `PUBLIC_` exception to it — static or computed.** `env("PUBLIC_X")` does not
work client-side either. **The supported pattern is: read the value in a loader,
which is server code, and return it as page data.**

```tsx
import { env } from "@warlock.js/core";
import type { PageLoaderContext, PageProps } from "@warlock.js/web";

export async function loader(_context: PageLoaderContext<undefined, undefined>) {
  return { siteName: env("PUBLIC_SITE_NAME") };
}

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

**Any reference to `process` is refused, aliased forms included — there is no
way around the check by renaming the binding:**

```tsx
const p = process; // aliased — refused
const p = globalThis.process; // globalThis alias — refused
const { env } = process; // destructured alias — refused
window.process; // window alias — refused
self.process; // self alias — refused
```

A local variable or parameter that happens to be named `process` (e.g.
`function f(process: Env) {}`) is not a reference to the global and is not
refused — only an obtainable reference to Node's actual `process` object is.

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
import type { PageConfig, PageLoaderContext, PageProps } from "@warlock.js/web";

export const config = {
  route: { path: "/products/:id", name: "products.details" },
  validation: { params: v.object({ id: v.string().minLength(2) }) },
} satisfies PageConfig;

export async function loader({
  request,
  response,
  shared,
}: PageLoaderContext<typeof config.validation, typeof config.route>) {
  const { params } = request.validated();
  const { id } = params;

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
}

export default function ProductDetailsPage({ data }: PageProps<typeof loader>) {
  return (
    <article lang={data.locale}>
      <h1>{data.product.name}</h1>
    </article>
  );
}
```

`LoaderShortCircuit` values from `notFound()` and redirects are excluded from `PageProps["data"]`, so the component sees only the successful loader return.

## What survives the wire

`app`/`layout`/`page` loader data travels the browser wire serialized with
[`devalue`](https://www.npmjs.com/package/devalue), not plain `JSON`. This is
the standing serialization ruling: a `resource` or a `toJSON()` method is the
gate on what a loader is allowed to return, never the wire format itself —
devalue is simply capable of carrying more of what a plain object graph can
already express.

Concretely, this now arrives on the client exactly as the loader returned it:

- `Date`, `Map`, `Set`, `BigInt`
- `undefined` as an object property's value (not just at the top level)
- a repeated reference to the SAME object (`{ first: shared, second: shared }`
  hydrates as `result.first === result.second`, not two independent copies)
- a cyclic structure (an object that (transitively) references itself)

A class instance devalue does not recognize, a function, or a symbol is still
refused — loudly. The build throws a `PageDataSerializationError` naming the
loader LEVEL (`app`/`layout`/`page`), the KEY PATH devalue's own error
reports (e.g. `.items[0].service`), and the page ROUTE, in both dev and
production:

```
Cannot serialize page data for route "products.details" (key path: .items[0].service):
Cannot stringify arbitrary non-POJOs. devalue cannot put a class instance, a function or a
symbol on the hydration wire — give the offending value a resource or a toJSON() so it
reaches the browser as a plain value. A resource / toJSON() is the serialization gate for
page data.
```

The fix is always the same: give the offending value a `resource` (see the
`define-resource` topic of the `warlock-js-core` skill) or a
`toJSON()` method so it reaches the wire as the plain value devalue already
knows how to serialize — never work around the throw by hand-flattening the
value in the loader.

This applies to `appData`/`layoutData`/`pageData` and to a `defer()`red value's
eventual settlement. It does **not** change `shared`, which keeps its own,
stricter gate (scalars, arrays, plain objects, or `toJSON()` — `Date`, `Map`,
`Set`, functions, and arbitrary class instances are rejected there
regardless) — see Declare the shared payload below.

## What the component sees: `Serialized<Return, "devalue">`

`data` in `PageProps`, `LayoutProps`, `AppProps` and in `config.metadata` callbacks is typed as what actually reaches the page, not the loader's raw return: `Serialized<Return, "devalue">` from `@warlock.js/core` (a `Response` the loader may return is excluded first). The loader's own declared return type is untouched.

```tsx title="src/web/products/product.page.tsx"
import type { PageProps } from "@warlock.js/web";
import { getProduct } from "app/products/services/get-product.service";

export async function loader() {
  const product = await getProduct(); // a Product model

  return { product, publishedAt: new Date() };
}

export default function ProductPage({ data }: PageProps<typeof loader>) {
  // data.product      -> the output of the model's resource (see below)
  // data.publishedAt  -> Date (devalue keeps it native)
  return <h1>{data.product.title}</h1>;
}
```

What each loader value becomes:

| Loader returns                                              | The page reads                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| a cascade model registered in `ModelResourceRegistry`       | that resource's output (`ResourceOutput<typeof XResource>`)             |
| a model with no registry entry                              | its serialized `data` type                                              |
| any value with `toJSON()`                                   | the (awaited) result of `toJSON()`                                      |
| `Date`, `Map`, `Set`, `RegExp`, `URL`                       | the same native type                                                    |
| a function-valued key                                       | removed from the type; devalue refuses a function at render, so do not return one |
| a class instance with private members and no `toJSON()`     | `never` (devalue would throw at render)                                 |
| a `defer()` key holding a promise                           | `Promise<Serialized<settled value>>`: the key stays a promise for `use()` |
| plain JSON-ish data                                         | unchanged                                                               |

A model with `static resource = ProductResource` is registered automatically: `warlock generate.typings` and `warlock dev` write `.warlock/typings/model-resources.d.ts`, so the page types it as the resource's output with no extra code.

See the `define-resource` topic of the `warlock-js-core` skill for `Serialized<T, W>` and the registry.

**A promise nested in plain loader data is awaited, and its settled value is serialized.** `return { product: getProduct() }` delivers the resolved `product` (a model resolved from a promise reaches the page as its `toJSON()` output instead of making devalue throw), and the type reads `Serialized` of the settled value. This is not streaming: only a top-level `defer()` key streams, and inside `defer()` a promise nested under a key is still refused with `NestedDeferredValueError`.

## Three loader levels

| Module                  | Contract       | Component props              |
| ----------------------- | -------------- | ---------------------------- |
| `src/web/root.tsx`      | `AppLoader`    | `AppProps<typeof loader>`    |
| positional `layout.tsx` | `LayoutLoader` | `LayoutProps<typeof loader>` |
| `*.page.tsx`            | `PageLoader`   | `PageProps<typeof loader>`   |

All receive one context object with `request`, `response`, `shared`, and `route`; page loaders also get `site` and `session` when those are configured. Page loaders add generics that connect their sibling `validation` and `route` exports to `request.validated()` and `request.input()`.

Page loaders, layout loaders, metadata callbacks, and page actions also receive `route: { name, path, params }` — the MATCHED page's route. Read it instead of `request.route`: under `sites`, core registers one `/*` catch-all per method, so `request.route` is that catch-all there. `name` is the page's `config.route.name`, or its generated name (never a `<site>.` prefixed or internal key); it is `undefined` only if the page has none.

## Abandoned-request signal

The runtime passes every loader a `signal`, an `AbortSignal` that fires when the client disconnects before the response finishes. The exported `PageLoaderContext` type does not declare it, so add it to the parameter type. Hand it to anything cancelable:

```ts
import type { PageLoaderContext } from "@warlock.js/web";

export async function loader({
  signal,
}: PageLoaderContext<undefined, undefined> & { signal: AbortSignal }) {
  const res = await fetch("https://api.example.com/products", { signal });
  return { products: await res.json() };
}
```

**Honest limitation:** a loader that never checks `signal` runs to completion anyway — the framework only stops the pipeline _between_ levels (app → layout → page), never inside a loader already running.

## Validation

A page's `config.validation` declares a [Seal](https://www.npmjs.com/package/@warlock.js/seal) schema per source, `params` and `query` kept as separate keys. Declare either or both:

```ts
export const config = {
  validation: {
    params: v.object({ id: v.int().coerce() }),
    query: v.object({ tab: v.string().optional() }).stripUnknown(),
  },
} satisfies PageConfig;
```

**`params` and `query` arrive as strings — coerce numeric ones.** `request.params`/`request.query` come off the URL, so `v.int()` alone rejects `"2"` ("This input accepts only numbers"). Reach for `v.int().coerce()` (or the matching coercing primitive) on every numeric param or query key.

**Seal objects reject unknown keys by default.** A `query` schema without `.stripUnknown()` answers 400 to `?utm_source=newsletter`, `?fbclid=…`, or any other tracking param a real visitor's link carries — that default is not changing. `.stripUnknown()` on the `query` object is the normal spelling for a public page; drop it only when you deliberately want to 400 on any extra key.

A legacy `{ schema, validating }` shape is still accepted — `schema` a single Seal validator, `validating` any ordered subset of `"body"`, `"query"`, `"params"`, and `"headers"` (defaulting to query + params, with params winning a duplicate key) — but it is legacy: `{ params, query }` is the shape every new page should declare. See the `create-a-page` topic (Validate the page's input) for the full example.

Either shape builds one schema and runs ONE validation pass at the page level's turn: after the app and layout loaders (so a layout redirect still wins, and the error page renders inside layouts that have their data), before the page loader. A failure short-circuits with status **400**, never 422 — a page is a document, not an API endpoint. A full page load renders the application's `error.page.tsx` with status 400, exactly as an ordinary loader throw with its own `statusCode` already does; the error it receives carries the validation issues:

```tsx title="src/web/error.page.tsx"
import type { ErrorPageProps } from "@warlock.js/web";

export default function ErrorPage({ error, status }: ErrorPageProps) {
  const validationErrors = (error as { errors?: { input: string; type: string; error: string }[] })
    ?.errors;

  return (
    <main>
      <h1>Something went wrong</h1>
      <p>Status: {status}</p>
      {validationErrors?.map((issue) => (
        <p key={issue.input}>
          {issue.input}: {issue.error}
        </p>
      ))}
    </main>
  );
}
```

In production this `errors` array is always the safe issue shape — `{ input, type, error }` — where `input`/`type` are the field name and failing rule, never the submitted value. In production, the `:value` placeholder in page-validation messages renders `…` instead of the submitted value. A custom rule or translation that builds its message from raw input without `:value` isn't covered, so keep submitted values out of custom message text.

A client navigation to the same URL still receives that same 400 status, with no document to render — nothing here changes the data representation's contract.

`request.validated()` uses the schema's output type, so fields with `.default(...)` are present. `request.input("id")` is narrowed from a literal route path when the loader uses `typeof route`.

## Execution order

Loaders run **sequentially, root to leaf, each one awaited before the next starts**: `root.tsx`'s `AppLoader`, then every matched `LayoutLoader` from outermost to innermost, then the page's `PageLoader`. The runtime has three top-level slots (`app`, `layout`, `page`), but the layout slot composes the full matched layout chain. A page may have only one _rendering_ layout; prefix-, middleware-, and loader-only layouts may still appear at multiple ancestry levels.

**The first core `Response` a loader returns is terminal.** Returning a `Response` object stops the pipeline immediately: no lower loader starts, `metadata` is not resolved, and that response is sent as-is. It is more terminal than a short-circuit — because the response is returned whole, the buffered header/cookie writes made at that same level are discarded along with everything below it. Use `response.redirect()` / `response.notFound()` (which produce a `LoaderShortCircuit`, committing that level's buffer inclusively) when you want your buffered writes to survive; return a raw `Response` only when you mean "this exact response, nothing else."

A loader that **throws** is also terminal: it stops lower loaders, discards its own level's buffer, and commits only the levels above it. A thrown `@warlock.js/core` `HttpError` (`ResourceNotFoundError`, `ForbiddenError`, `BadRequestError`, `ConflictError`, …) keeps its own status: a 404 renders your `404.page.tsx` exactly like `response.notFound()`, and any other 4xx renders `error.page.tsx` with that status and its own message, without reaching `web.errors.report()`; a plain throw (or a resolved 5xx) still renders `error.page.tsx` with the generic 500.

## Loader response surface

Each loader gets its own buffered response, never the live one, so that a level discarded by a short-circuit or a throw cannot leak half-written headers or cookies onto a response it no longer owns. These are all of its public methods. The first six return the buffered response, so they chain; the last three return a short-circuit value that you must `return`.

| Method                                  | What it does                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `header(key, value)`                    | Queue one response header. The value is converted with `String()`                                   |
| `headers(bag)`                          | Queue every entry of a `Record<string, unknown>` as a header                                        |
| `setStatusCode(code)`                   | Queue the status code. There is no `status()` method                                                |
| `cookie(name, value, options?)`         | Queue a `Set-Cookie`. Same arguments as core `response.cookie()`                                    |
| `clearCookie(name, options?)`           | Queue a cookie deletion. Same arguments as core `response.clearCookie()`                            |
| `redirect(url, statusCode = 302)`       | Queue the status and `Location`, and return a redirect short-circuit                                |
| `permanentRedirect(url)`                | `redirect(url, 301)`                                                                                |
| `notFound(body?)`                       | Queue status 404 and return a not-found short-circuit that renders your `404.page.tsx`              |

```ts
response.header("cache-control", "private, max-age=60");
response.headers({ "x-feature": "beta", "x-tenant": tenantKey });
response.setStatusCode(201);
return response.redirect("/login");
return response.permanentRedirect("/products");
return response.notFound();
```

Do not continue after a redirect or `notFound`; return the result. Surviving buffers are committed root to leaf. For the same header key (case-insensitive) or the same cookie name, the leafward write wins. A loader that throws, or a lower level discarded by a short-circuit, does not leak its buffered writes.

### Cookies

`cookie()` and `clearCookie()` take the same options as the core `Response` (`maxAge` in seconds, `path`, `domain`, `httpOnly`, `sameSite`, `secure`, plus `raw`):

- **Secure defaults.** A cookie is `httpOnly`, `sameSite: "lax"` and, outside development, `secure`. Override per call (`{ httpOnly: false }`) only when browser code must read it.
- **JSON by default.** The value is `JSON.stringify`-ed, and `request.cookie(name)` parses it back. Pass `{ raw: true }` for a plain string such as a token.
- **Match the scope when clearing.** A cookie is deleted only when `clearCookie` is given the same `path` (and `domain`) it was set with.
- **Not cacheable.** A response that sets or clears a cookie is always `Cache-Control: private, no-store`, even on a page with a `config.cache` opt-in.
- **Reads see the incoming cookie.** Within the same request `request.cookie()` returns what the browser sent, not what you just queued.

A theme preference, set from a query string and cleared on request:

```tsx title="src/web/settings.page.tsx"
import type { PageConfig, PageLoaderContext, PageProps } from "@warlock.js/web";

const ONE_YEAR = 60 * 60 * 24 * 365;

export const config = { route: { path: "/settings", name: "settings" } } satisfies PageConfig;

export async function loader({ request, response }: PageLoaderContext<undefined, typeof config.route>) {
  const requested = request.input("theme");

  if (requested === "dark" || requested === "light") {
    response.cookie("theme", requested, { maxAge: ONE_YEAR, path: "/", httpOnly: false });

    return { theme: requested };
  }

  if (requested === "reset") {
    response.clearCookie("theme", { path: "/" });

    return { theme: "light" };
  }

  return { theme: request.cookie("theme", "light") as string };
}

export default function SettingsPage({ data }: PageProps<typeof loader>) {
  return <p>Current theme: {data.theme}</p>;
}
```

A form that sets or clears a cookie on submit belongs in a page action; see the `handle-a-form-action` topic.

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
import type { AppProps, RootConfig } from "@warlock.js/web";
import "./types";

const publishLocale = async () => {
  writableShared.locale = "en";
};

export const config = { middleware: [publishLocale] } satisfies RootConfig;

export default function App({ children, shared }: AppProps) {
  return (
    <html lang={shared.locale}>
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

- **Let the loader's return type be inferred.** Use `satisfies PageLoader<...>` on an arrow function or a typed named function; never `: PageLoader`, which erases the return type that `PageProps` needs.
- **Return client-safe data.** Components render again in the browser; models and server handles do not survive the wire. `Date`/`Map`/`Set`/`BigInt` DO survive now (devalue is the wire format — see [What survives the wire](#what-survives-the-wire)); a class instance, function, or symbol still does not, and fails the build loudly instead of silently.
- **Write `shared` in middleware only.** Loaders run after the seal.
- **Required shared keys need unconditional writers.** The type is a promise for every request.
- **Do not use loader return values as cross-level communication.** Levels run in order but are not wired to each other; use `shared`, written in middleware.
- **`404.page.tsx` never runs its own loader.** The not-found page's module is registered and rendered for real — `register()` and its middleware still run — but the page loader is omitted from the request in both dev and production, so a missing URL cannot trigger application data work or fail a second time. Its ancestry contributes nothing either: the 404 page renders with an empty layout chain by construction. **The root `AppLoader` in `root.tsx` still runs** for a 404 request, so keep it cheap and make sure it tolerates a request that matched nothing.
- **`process.env` is refused in the client/universal graph, with no `PUBLIC_` exception.** Read it in a loader and return it as page data.
- **In `warlock dev`, app modules can load twice.** Loaders import through Vite SSR while HTTP handlers load natively, so a module-level singleton (`AsyncLocalStorage`, cache, registry) may exist in two copies. Until the single module graph (planned 5.26), store it on `globalThis[Symbol.for("your-app.name")]`; `warlock start` has one graph and is unaffected.
- **Server actions are not supported.** POST to an ordinary Warlock API route and call `refresh()` after success.
- **Responses now stream via React's streaming renderer.** The response still waits for every loader, middleware short-circuit and validation to settle before the first byte goes out — status codes, headers and cookies are unchanged — so this is not an API change for apps built on the framework.

## See also

- `create-a-page` topic: the complete page module, including `404.page.tsx`.
- `set-page-metadata` topic: metadata functions that receive this loader's data.
- `write-the-root` topic: `AppLoader`, `<Head />`, and `<Scripts />`.
- `use-layouts` topic: `LayoutLoader` and persistent wrappers.
- `navigate-on-the-client` topic: re-fetch loaders with `refresh()`.
- `stream-deferred-data` topic: stream a slow page-loader key after the shell with `defer()` and `use()`.
- `handle-a-form-action` topic: set cookies and redirect from a form POST.
