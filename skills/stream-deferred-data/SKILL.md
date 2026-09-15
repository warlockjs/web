---
name: stream-deferred-data
description: 'Stream slow page-loader data after the shell with `defer()` and React `use()` inside `<Suspense>`, instead of blocking the first byte on it. Covers the wire contract (a deferred value settles as a chunk script after the shell, or as an NDJSON line on client navigation), errors reaching the nearest `<Suspense>` error boundary with status 200 already sent, `web.streaming.deferTimeout`, and the metadata rule (`metadata()` may read only resolved keys). Triggers: `defer()`, `use(data.`, `DeferredValueError`, `DeferTimeoutError`, `DeferredStreamClosedError`, `DeferredKeyInMetadataError`, `web.streaming.deferTimeout`, `__WARLOCK_DEFER__`; "stream part of a page", "slow loader data", "show a skeleton while reviews load", "Suspense in a page component", "defer a promise from a loader". Skip: the rest of the loader contract — `@warlock.js/web/load-page-data/SKILL.md`; re-fetching after a mutation — `@warlock.js/web/navigate-on-the-client/SKILL.md`; competing primitives Remix `defer()`/`Await`, Next.js `loading.tsx`/streaming RSC (this framework has no RSC).'
---

# Warlock — stream deferred page data

A page loader normally blocks the whole response on everything it returns.
`defer()` lets a PAGE loader (app and layout loaders cannot use it) mark some
of its top-level keys as "send the shell now, stream this in after" — the
first byte still waits for middleware, validation and every non-deferred
loader value, but a slow key no longer holds up everything else.

## The shape

```tsx title="src/web/products/product-details.page.tsx"
import { use, Suspense } from "react";
import { defer } from "@warlock.js/web";
import type { PageLoader, PageProps } from "@warlock.js/web";

export const loader = (async ({ request }) => {
  const { id } = request.validated();

  return defer({
    product: await getProduct(id), // resolved before the shell — unchanged today
    reviews: getReviews(id), // a Promise — streamed in after the shell
  });
}) satisfies PageLoader;

function Reviews({ reviews }: { reviews: Promise<Review[]> }) {
  const list = use(reviews);
  return (
    <ul>
      {list.map((review) => (
        <li key={review.id}>{review.text}</li>
      ))}
    </ul>
  );
}

export default function ProductDetailsPage({ data }: PageProps<typeof loader>) {
  return (
    <article>
      <h1>{data.product.name}</h1>
      <Suspense fallback={<p>Loading reviews…</p>}>
        <Reviews reviews={data.reviews} />
      </Suspense>
    </article>
  );
}
```

- `defer(data)` takes the SAME object shape a loader always returned. Any
  TOP-LEVEL key whose value is a promise streams in after the shell; every
  other key goes into `pageData` exactly as before — a loader that never
  calls `defer()` is completely unaffected.
- Only TOP-LEVEL keys may be promises. A promise nested inside a resolved
  key's own value (`defer({ list: { items: fetchItems() } })`) throws
  `NestedDeferredValueError` naming the path — move it to its own top-level
  key instead.
- `data.reviews` types as `Promise<Review[]>` for the component, exactly the
  type the loader declared — `PageProps`/`LoaderData` only unwrap the
  loader's own outer promise, never a deferred key's.
- Read a deferred key with React's own `use()`, inside a `<Suspense>`
  boundary. `use()` is plain React, not a Warlock export.
- `defer()` is PAGE-loader-only. An app or layout loader that returns one
  throws `DeferredInNonPageLoaderError` — those levels compose every page
  under them, including pages with no `<Suspense>` boundary at all, so their
  data cannot usefully stream.

## Errors go to the nearest boundary — status 200 already sent

By the time a deferred value settles, the shell has already flushed with
status 200: headers, cookies and the status code were decided before the
first byte went out, and nothing about a LATER value can change any of that.
So a rejected deferred value never produces a different HTTP status — it
resolves to the nearest **`<Suspense>`**'s enclosing React error boundary,
the same way a synchronous render throw would, while the response the
browser already started receiving stays a 200.

What `use()` throws is one of:

- **`DeferredValueError`** — the loader's own promise rejected. Carries the
  original error's `message` and, if the original error had one,
  `statusCode`. Never a stack in production; dev may add one.
- **`DeferTimeoutError`** — the promise did not settle within
  `web.streaming.deferTimeout` (default 10000ms). The server treats this
  exactly like a rejection: settle, emit, move on. The response is never
  held open waiting for a value that times out.
- **`DeferredStreamClosedError`** — the connection was cut (or the page
  navigated away) while a key was still pending. The client rejects every
  still-pending key with this on `DOMContentLoaded`.

None of these trigger a hard navigation or reload — the payload the shell
sent was already complete, and only a deferred value inside a `<Suspense>`
boundary failed. Every rejection and every timeout is ALSO reported to the
server's error sink unconditionally, regardless of whether any component
ever reads the deferred key.

```tsx title="src/web/products/reviews-boundary.tsx"
import { Component, type ReactNode } from "react";

export class ReviewsBoundary extends Component<
  { children: ReactNode },
  { error?: unknown }
> {
  state: { error?: unknown } = {};

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  render() {
    if (this.state.error) return <p>Reviews are unavailable right now.</p>;
    return this.props.children;
  }
}
```

Wrap the `<Suspense>` boundary (or an ancestor of it) in a boundary like this
one when a deferred failure should degrade gracefully instead of bubbling to
the page's own `ErrorBoundary` export.

## `web.streaming.deferTimeout`

```ts title="warlock.config.ts"
export default {
  web: {
    streaming: {
      deferTimeout: 15_000, // milliseconds; default 10000
    },
  },
};
```

Applies per deferred key, not per request — three deferred keys on one page
each get their own 10-second (or configured) budget, timed independently.

## The metadata rule

**`metadata()` may read only RESOLVED keys.** It runs before the shell
flushes; a deferred key resolves only after. Reading one throws
`DeferredKeyInMetadataError` — naming the key and the page — in dev AND in
production, unconditionally:

```tsx
export const loader = (async () =>
  defer({ product: await getProduct(id), reviews: getReviews(id) })
) satisfies PageLoader;

// Wrong — "reviews" is a defer()-ed key:
export const metadata = (({ data }) => ({
  title: `${data.reviews.length} reviews`, // throws DeferredKeyInMetadataError
})) satisfies PageMetadata<typeof loader>;

// Right — describe the page from what's already resolved:
export const metadata = (({ data }) => ({
  title: data.product.name,
})) satisfies PageMetadata<typeof loader>;
```

There is no way to make `metadata()` wait for a deferred value — a page's
`<head>` is part of the shell, and the shell is exactly the thing `defer()`
exists to stop waiting on. If the description genuinely needs the deferred
value, resolve it inside the loader instead of deferring it.

## Client navigation (NDJSON) — handled automatically

A client-side navigation (`<Link>`, `navigateTo()`, `refresh()`) fetches page
data instead of a full document. When the browser's data request advertises
NDJSON support, the response streams the same way the document did: line 1
is the complete payload (including which keys are still pending), then one
line per resolved deferred key as it settles. `<Suspense>` shows the fallback
until each key's line arrives — nothing in a page component or loader has to
know or care that this is happening; the same `use(data.reviews)` call reads
the wire promise on both the initial document and every later client
navigation. A client that cannot speak NDJSON gets the older contract
instead: the server awaits every deferred value and inlines the fully
resolved data into one JSON response.

## Crawlers

A crawler never runs the browser's defer-bootstrap script, so it has no
chance to observe a chunk that arrives after the shell — streamed to one, a
`defer()`-ed section would stay missing from whatever it indexes forever.
Every FULL-DOCUMENT request from a detected crawler therefore skips streaming
entirely: every deferred value is awaited and inlined into the page data
before the first byte goes out (the same await-and-inline path a plain data
request without NDJSON support already gets), and the response waits for
React's `onAllReady` before anything flushes. A rejection takes the ordinary
boundary/status escalation path, exactly as an ordinary synchronous loader
throw would — nothing has flushed yet, so there is no 200 already on the
wire to contradict.

Detection is case-insensitive and, by default, matches this built-in list:
`googlebot`, `bingbot`, `yandex`, `duckduckbot`, `baiduspider`, `slurp`,
`applebot`, `facebookexternalhit`, `twitterbot`, `linkedinbot`, `discordbot`,
`slackbot`, `telegrambot`, `whatsapp`, `embedly`, `pinterest`.

```ts title="warlock.config.ts"
export default {
  web: {
    streaming: {
      crawlers: false, // disable detection entirely — every request streams
      // OR customise it:
      crawlers: {
        userAgents: [/mybot/i], // REPLACES the built-in list, not merges with it
        detect: (request) => request.header("x-render-mode") === "crawler", // wins outright when given
      },
    },
  },
};
```

A page that never calls `defer()` renders identically for every user agent
and never carries a `Vary` header. A page that DOES `defer()` renders
differently depending on the request's `User-Agent` — streamed for a
browser, fully resolved for a detected crawler — so the document response
carries `Vary: User-Agent` whenever the page uses `defer()`, so a shared
cache never serves one representation to a client that asked for the other.

## Gotchas

- **Only page loaders may `defer()`.** App/layout loaders throw
  `DeferredInNonPageLoaderError`.
- **Only top-level keys may be promises.** A promise nested under a resolved
  key throws `NestedDeferredValueError`.
- **`metadata()` reads resolved keys only.** A deferred key throws
  `DeferredKeyInMetadataError`, naming the key and the page.
- **A deferred rejection never changes the response's status.** It resolves
  to the nearest `<Suspense>` error boundary; the document (or NDJSON
  stream) it arrived on already answered 200.
- **`use()` is plain React**, not a Warlock export — import it from `"react"`.

## See also

- [`load-page-data/SKILL.md`](../load-page-data/SKILL.md) — the rest of the loader contract `defer()` builds on.
- [`navigate-on-the-client/SKILL.md`](../navigate-on-the-client/SKILL.md) — the NDJSON data request this streams over.
