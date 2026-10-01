---
name: test-a-page
description: 'Test a Warlock page with Vitest: call a page `loader` and a page `action` directly with a hand-built context (mocking the service they call), render the page component to HTML with `renderToString` inside `LocaleProvider`, and run a full-stack check against the real server with `testGet` from `@warlock.js/core/tests`. Triggers: `vitest`, `loader` test, `action` test, `PageLoader`, `PageActionContext`, `LocaleProvider`, `renderToString`, `testGet`, `RouteTableNotPublishedError`, `outside Warlock''s LocaleProvider`; "test a page", "unit test a loader", "test a form action", "test SSR output", "mock the service in a page test", "test a component that uses Link", "React is not defined in my test". Skip: testing API routes, controllers and repositories — the `warlock-js-core` skill; writing the page itself — the `create-a-page`, `load-page-data` and `handle-a-form-action` topics; competing tools `@testing-library/react`, Playwright and Cypress browser tests.'
---

# Warlock — test a page

A page is three plain things, and each is tested at the cheapest level that covers it:

| What | How | Needs a server? |
| --- | --- | --- |
| `loader` and `action` | Call the exported function with a small fake context, mock the service it calls | No |
| The page component | `renderToString` it inside `LocaleProvider` with the `data` the loader would return | No |
| The whole route (middleware, validation, document) | `testGet` against the real test server | Yes |

The first two are fast, need no database and no running app. Reach for the third only for what they cannot see.

## Setup

`warlock add test` installs the harness: `src/test-global-setup.ts` (starts the HTTP server once), `src/test-setup.ts` (boots the app runtime before every test file) and a `vite.config.ts` whose Vitest block is:

```ts
test: {
  globalSetup: "./src/test-global-setup.ts",
  setupFiles: ["./src/test-setup.ts"],
  environment: "node",
  globals: false,
  include: ["src/app/**/*.test.ts"],
},
```

Two consequences for page specs:

- **That `include` does not match page specs.** Files under `src/web/` and any `.tsx` spec are never collected. Widen it (for example add `"src/web/**/*.test.{ts,tsx}"`), or keep the unit specs in a second config that has no setup files and no server, which is also faster:

  ```ts title="vitest.web.config.ts"
  import { defineConfig } from "vitest/config";

  export default defineConfig({
    test: { environment: "node", include: ["src/web/**/*.{test,spec}.{ts,tsx}"] },
  });
  ```

  Run it with `vitest run --config vitest.web.config.ts`. If a page imports through the `app/...` or `web/...` path aliases, give this config the same `plugins` as `vite.config.ts`; the specs below use relative imports only.
- **JSX needs the tsconfig.** The generated `tsconfig.json` has `"jsx": "react-jsx"` and `include: ["src", ...]`. A spec outside `src/` is transformed with the classic JSX runtime and fails with `React is not defined`; keep specs under `src/`.

## The page under test

```tsx title="src/web/products/product.page.tsx"
import { v } from "@warlock.js/seal";
import { Link, useTrans } from "@warlock.js/web";
import type { PageActionContext, PageConfig, PageLoader, PageProps } from "@warlock.js/web";
import { findProduct, subscribe } from "./products.service";

const subscribeSchema = v.object({ email: v.string().email() });

export const config = {
  route: { path: "/products/:id", name: "products.details" },
  action: { validation: subscribeSchema },
} satisfies PageConfig;

export const loader = (async ({ request, response }) => {
  const product = await findProduct(request.input("id"));

  if (!product) {
    return response.notFound();
  }

  return { product };
}) satisfies PageLoader<undefined, typeof config.route>;

export async function action({ request, response }: PageActionContext<typeof subscribeSchema>) {
  const { email } = request.validated();

  if (email === "blocked@example.com") {
    return response.forbidden({ message: "Not allowed." });
  }

  await subscribe(email);

  return response.redirect("/products/42?subscribed=1");
}

export default function ProductPage({ data }: PageProps<typeof loader>) {
  const t = useTrans();

  return (
    <main>
      <h1>{data.product.name}</h1>
      <Link href="/products">{t("products.back")}</Link>
    </main>
  );
}
```

Keep the I/O in a service module (`products.service.ts`) so the test can replace it. The loader and the action stay thin.

## Test the loader and the action

A loader or action receives one context object (`request`, `response`, `shared`, `signal`, `route`). Build only the members your function touches and cast once, at the boundary. The `makeContext` helper below is test code you own; Warlock does not export a request factory for pages.

```tsx title="src/web/products/product.spec.tsx"
import { LocaleProvider } from "@warlock.js/web";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ProductPage, { action, loader } from "./product.page";
import * as service from "./products.service";

vi.mock("./products.service", () => ({
  findProduct: vi.fn(),
  subscribe: vi.fn(),
}));

// A loader/action is a plain async function of one context object. Build only
// the members it touches and cast once, at the boundary.
function makeContext<TFn extends (context: never) => unknown>(parts: {
  input?: Record<string, string>;
  validated?: Record<string, unknown>;
}) {
  const response = {
    notFound: vi.fn(() => ({ kind: "notFound" as const })),
    redirect: vi.fn((url: string) => ({ kind: "redirect" as const, url })),
    forbidden: vi.fn((body: unknown) => ({ kind: "forbidden" as const, body })),
  };
  const request = {
    input: (key: string) => parts.input?.[key],
    validated: () => parts.validated,
  };
  const context = {
    request,
    response,
    shared: {},
    signal: new AbortController().signal,
    route: { name: "products.details", path: "/products/:id", params: parts.input ?? {} },
  } as unknown as Parameters<TFn>[0];

  return { context, response };
}

describe("product page loader", () => {
  it("returns the product", async () => {
    vi.mocked(service.findProduct).mockResolvedValue({ id: "42", name: "Anvil" });
    const { context } = makeContext<typeof loader>({ input: { id: "42" } });

    await expect(loader(context)).resolves.toEqual({ product: { id: "42", name: "Anvil" } });
    expect(service.findProduct).toHaveBeenCalledWith("42");
  });

  it("short-circuits with notFound for an unknown id", async () => {
    vi.mocked(service.findProduct).mockResolvedValue(undefined);
    const { context, response } = makeContext<typeof loader>({ input: { id: "nope" } });

    const result = await loader(context);

    expect(response.notFound).toHaveBeenCalledOnce();
    expect(result).toEqual({ kind: "notFound" });
  });
});

describe("product page action", () => {
  it("saves and redirects", async () => {
    const { context, response } = makeContext<typeof action>({
      validated: { email: "ada@example.com" },
    });

    const result = await action(context);

    expect(service.subscribe).toHaveBeenCalledWith("ada@example.com");
    expect(response.redirect).toHaveBeenCalledWith("/products/42?subscribed=1");
    expect(result).toEqual({ kind: "redirect", url: "/products/42?subscribed=1" });
  });

  it("refuses a blocked address without saving", async () => {
    vi.mocked(service.subscribe).mockClear();
    const { context, response } = makeContext<typeof action>({
      validated: { email: "blocked@example.com" },
    });

    await action(context);

    expect(response.forbidden).toHaveBeenCalledWith({ message: "Not allowed." });
    expect(service.subscribe).not.toHaveBeenCalled();
  });
});
```

What this does and does not prove:

- It proves your branching: which service call, which short-circuit, which response helper. The fake `response` records the call and returns a marker, so assert on the call and on the value your function returns.
- It does **not** run `config.action.validation`. A real action only runs after the schema passes (a failure is a 422 before your code), so supply `validated` already valid and test the schema separately by calling it with `@warlock.js/seal` directly. The same goes for `config.middleware`: test a middleware as its own function.
- It does not prove the HTTP outcome (303 versus 204, status codes, cookies). That is level three.

## Render the page to HTML

`renderToString` the default export with the props the page receives: `data` (what the loader returned), `shared` and `params`. Wrap it in `LocaleProvider`, because `useTrans()` and `useLocale()` throw outside it (`... was called outside Warlock's LocaleProvider`).

```tsx title="src/web/products/product.spec.tsx"
describe("product page render", () => {
  it("renders the component to HTML with loader data and translations", () => {
    const html = renderToString(
      <LocaleProvider locale="en" translations={{ products: { back: "Back to products" } }}>
        <ProductPage
          data={{ product: { id: "42", name: "Anvil" } }}
          shared={{}}
          params={{ id: "42" }}
        />
      </LocaleProvider>,
    );

    expect(html).toContain("<h1>Anvil</h1>");
    expect(html).toContain('<a href="/products">Back to products</a>');
  });
});
```

`translations` is the selected-locale snapshot as a nested object (`{ products: { back } }` answers `t("products.back")`); omit it and `useTrans()` falls back to the global `@mongez/localization` registry. Missing keys render as the key itself, which is a handy assertion that you forgot one.

Things that behave differently in a bare render, all of which are the framework doing its job on the server:

- **`<ClientOnly>` renders its `fallback`.** `renderToString` output contains the fallback and never calls a function child, so no `window` is read. Test the browser-only branch separately, or in a browser test.
- **`<Link to="route.name">` throws `RouteTableNotPublishedError`.** A route name resolves through the table the server publishes at boot, and a unit render has none; the table is not exported for tests. Use a literal destination (`<Link href="/products">` needs no table), or replace `Link` for the spec:

  ```tsx
  vi.mock("@warlock.js/web", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@warlock.js/web")>();

    return {
      ...actual,
      Link: ({ to, href, ...rest }: { to?: string; href?: string }) => (
        <a href={href ?? `/${to}`} {...rest} />
      ),
    };
  });
  ```

- **`useIsClient()` is `false`**, so anything behind it shows its server output.
- **`currentRoute()` is `undefined`**, as it is during real server rendering.

## Test the whole route against the real server

For what the fakes cannot see (middleware, the validation pass, the document, the status code), run the app. The generated app ships a spec that does this with the helpers from `@warlock.js/core/tests` (`src/app/shared/tests/infrastructure.test.ts`):

```ts title="src/app/shared/tests/infrastructure.test.ts"
import { testGet } from "@warlock.js/core/tests";
import { describe, expect, it } from "vitest";

describe("Test Infrastructure", () => {
  it("should be able to make HTTP requests to test server", async () => {
    const response = await testGet("/");

    expect(response.status).toBeDefined();
    expect(response.headers.get("content-type")).toBe("text/html");
  });
});
```

`testGet(path)` returns a standard `fetch` `Response`, so `await response.text()` is the rendered HTML. `testPost`, `testPut`, `testPatch`, `testDelete`, `testRequest` and `getTestServerUrl` come from the same module. A page action POST needs a same-origin `Origin` (or `Referer`) header or it answers 403, so pass `headers: { origin: getTestServerUrl() }`. These specs need the `warlock add test` harness above (the connectors, and the database if the page reads it) and must match its `include` (`src/app/**/*.test.ts`), so keep them few and let the unit-level specs carry the branches.

## Gotchas

- **Cast the context once.** `as unknown as Parameters<typeof loader>[0]` in one helper keeps every spec readable; do not scatter `any`.
- **Mock the service, not Warlock.** Mock the module your loader calls (`vi.mock("./products.service", ...)`), not `@warlock.js/web`, except for the `Link` stand-in above.
- **Serialization is not exercised.** A real loader's return is serialized to the browser (see the `load-page-data` topic); your unit test hands the component the raw object. Cover any value whose shape changes in transit in the full-stack check.

## See also

- The `load-page-data` topic: the loader context (`request`, `response`, `shared`, `signal`, `route`) you are faking.
- The `handle-a-form-action` topic: action rules, `PageActionContext` and the 422 validation outcome.
- The `stream-deferred-data` topic: for `defer()` data, hand the component a promise you created.
- The `render-client-only` topic: what `<ClientOnly>` does in a server render.
- The `create-a-page` topic: the page module shape.
