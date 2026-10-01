---
name: set-page-metadata
description: "Set a page's `<head>` with `config.metadata`: title (string, `{ default, template }`, `{ absolute }`), description, keywords, canonical, robots, `openGraph` (siteName, images, article), `twitter`, `image`, `authors`, extra `meta` and `links`, and per-locale `alternates`. Static object vs function of loader data, root/layout/page merge order, and a per-locale recipe with `t()`. Triggers: `config.metadata`, `PageMetadata`, `MetadataInput`, `openGraph`, `og:image`, `twitter:card`, `canonical`, `hreflang`, `alternates`, `UnknownMetadataKeyError`, `DeferredKeyInMetadataError`; \"set the page title\", \"add an og:image\", \"share preview\", \"title template\", \"noindex a page\", \"translate the title\"."
---

# Warlock — set page metadata

A page describes its `<head>` in `config.metadata`. The server resolves it after the loader, injects it into the document before the first byte, and rewrites the same tags after a client navigation. `<Head />` in `root.tsx` only decides where the tags are placed (see the `write-the-root` topic).

`metadata` is a field of `config` on three modules: a page (`PageConfig`), a positional `layout.tsx` (`LayoutConfig`) and `root.tsx` (`RootConfig`). All three take the same shape.

```tsx title="src/web/products/index.page.tsx"
import type { PageConfig } from "@warlock.js/web";

export const config = {
  route: { path: "/products", name: "products.index" },
  metadata: {
    title: "Products",
    description: "Browse the product catalogue",
  },
} as const satisfies PageConfig;

export default function ProductsPage() {
  return <h1>Products</h1>;
}
```

## Static object or function

`metadata` is either a plain object or a function that returns one. The function form runs on the server, after the loader, and receives one object:

| Key      | What it is                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------- |
| `data`   | The loader's data, typed exactly as the component sees it (`Serialized` of the loader return)         |
| `shared` | The sealed, readonly `shared` payload                                                                 |
| `route`  | The matched page's `{ name, path, params }`                                                           |
| `child`  | Layout and root callbacks only: the already-resolved metadata of the level below (`{ kind, metadata, child? }`) |

Give the config the loader's type so `data` is typed. `PageConfig<typeof loader>` reads the loader's type, so the loader may be declared after the config:

```tsx title="src/web/products/product-details.page.tsx"
import type { PageConfig, PageLoader, PageProps } from "@warlock.js/web";

export const config = {
  route: { path: "/products/:id", name: "products.details" },
  metadata: ({ data }) => ({
    title: data.product.name,
    description: data.product.summary,
    openGraph: {
      type: "product",
      siteName: "Acme Store",
      images: [{ url: data.product.image, width: 1200, height: 630, alt: data.product.name }],
    },
    twitter: { card: "summary_large_image", site: "@acme" },
  }),
} as const satisfies PageConfig<typeof loader>;

export const loader = (async ({ request }) => {
  const id = request.input("id");

  return {
    product: {
      name: `Product ${id}`,
      summary: "A very good product",
      image: `/images/products/${id}.jpg`,
    },
  };
}) satisfies PageLoader;

export default function ProductDetailsPage({ data }: PageProps<typeof loader>) {
  return <h1>{data.product.name}</h1>;
}
```

Rules of the function form:

- **It runs only when the loader resolved.** If the loader throws, the framework uses a fixed error metadata (`title: "Something went wrong"`, `robots: "noindex"`) and never calls your function, so `data` is always present.
- **It is skipped when a loader short-circuits** with `response.redirect()` or `response.notFound()`; there is no page to describe.
- **Read resolved keys only.** Reading a `defer()` key inside `metadata` throws `DeferredKeyInMetadataError`, because the head is sent before deferred values settle (see the `stream-deferred-data` topic).
- **It is server-only.** The browser receives the resolved tags, not the function.

## Every field

All fields are optional. An unknown key (`tittle`) is a build error naming the file, line and the closest known key, so a typo cannot silently drop a tag.

| Field         | Type                                                                            | Rendered as                                                                  |
| ------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `title`       | `string`, `{ default?, template? }` or `{ absolute }`                           | `<title>`                                                                    |
| `description` | `string`                                                                        | `<meta name="description">`                                                  |
| `keywords`    | `string` or `string[]` (joined with `, `)                                       | `<meta name="keywords">`                                                     |
| `robots`      | `string`, e.g. `"noindex,nofollow"`                                             | `<meta name="robots">`                                                       |
| `canonical`   | `string` (path or absolute URL) or `false`                                      | `<link rel="canonical">`                                                     |
| `image`       | `string` or `{ url, width?, height?, alt?, type? }`                             | The share image: fallback for `og:image` and `twitter:image`                 |
| `authors`     | `string`, or an array of `string` / `{ name, url? }`                            | `<meta name="author">` (names joined), plus `<link rel="author">` per `url`  |
| `openGraph`   | see below                                                                       | `og:*` and `article:*` tags                                                  |
| `twitter`     | see below                                                                       | `twitter:*` tags                                                             |
| `meta`        | array of `{ name, content }`, `{ property, content }` or `{ httpEquiv, content }` | Extra `<meta>` tags                                                          |
| `links`       | array of `{ rel, href, hreflang?, type?, sizes?, media?, as?, crossOrigin?, title? }` | Extra `<link>` tags                                                          |
| `alternates`  | `Record<string, string>` keyed by locale code plus optional `"x-default"`       | `<link rel="alternate" hreflang="...">`                                      |

### Title

```ts
title: "Products"; // "Products"
title: { default: "Acme Store", template: "%s | Acme Store" }; // template wraps a descendant's title
title: { absolute: "Acme Store - Home" }; // ignores any ancestor template
```

A `template` is applied by an ancestor to the title of the level below it, replacing `%s`. Put the template on `root.tsx` or a layout, then each page sets a plain `title: "Products"` and renders as `Products | Acme Store`. With a `template` and no descendant title, the `default` is used as is. `{ absolute }` opts one page out of every ancestor template. The title is always a plain string by the time it is rendered.

### `openGraph`

| Key                | Notes                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `title`            | Falls back to the top-level `title`, even when `openGraph` is not set                                    |
| `description`      | Falls back to the top-level `description`                                                                |
| `type`             | `"website"` (the default whenever any `og:*` tag is emitted), `"article"`, `"product"`, `"profile"`, or any string |
| `url`              | Falls back to the canonical URL                                                                          |
| `siteName`         | `og:site_name`                                                                                           |
| `images`           | Array of `{ url, width?, height?, alt?, type? }`; one `og:image` group each. Wins over `image`           |
| `image`            | A single URL, kept for compatibility. `images` wins over it                                              |
| `locale`           | Written as given. Defaults to the request locale (`en-US` becomes `en_US`)                               |
| `alternateLocales` | `og:locale:alternate`, one tag per entry. Filled from the page's locale alternates when not set          |
| `article`          | Rendered only when `type` is `"article"`: `publishedTime`, `modifiedTime`, `authors[]`, `section`, `tags[]` |

```tsx
metadata: ({ data }) => ({
  title: data.post.title,
  description: data.post.excerpt,
  image: data.post.cover,
  authors: [{ name: data.post.author, url: "/authors/ada" }],
  openGraph: {
    type: "article",
    siteName: "Acme Blog",
    article: {
      publishedTime: data.post.publishedAt,
      section: "Engineering",
      tags: ["ssr", "react"],
    },
  },
});
```

### `twitter`

`card`, `title`, `description`, `image`, `imageAlt`, `site`, `creator`. `title`, `description`, `image` and `imageAlt` fall back to the `og:*` value (and the share `image`). `card` defaults to `summary_large_image` when there is an image and `summary` when there is not. Twitter tags are emitted only when some Open Graph or Twitter field exists.

### `meta` and `links`

Use them for tags no built-in field covers (verification tokens, `theme-color`, icons, preloads):

```ts
meta: [
  { name: "theme-color", content: "#0b0b0f" },
  { property: "fb:app_id", content: "1234567890" },
  { httpEquiv: "x-ua-compatible", content: "IE=edge" },
],
links: [
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
  { rel: "preconnect", href: "https://cdn.example.com", crossOrigin: "anonymous" },
],
```

- A built-in field always wins. A `meta` entry that addresses a tag a built-in field owns (`description`, `keywords`, `robots`, `og:*`, `twitter:*`, `article:*`) is dropped with a development warning.
- `httpEquiv` accepts only `content-type`, `default-style`, `x-ua-compatible` and `content-security-policy`.
- A `link` with `rel="canonical"` is dropped (use `canonical`), as is one with an invalid `rel`, a missing `href` or a `javascript:` URL. A `rel="alternate"` link whose `hreflang` is also a key of `alternates` is dropped too.

### `canonical`, `robots` and absolute URLs

When the app has a public URL configured (`app.publicUrl`; under multi-site, the site's own host), the server fills in the rest:

- `canonical` defaults to the public URL plus the request path (query string and hash ignored). Set a string to override it, or `false` for no canonical link and no automatic `og:url`.
- A root-relative `canonical`, `openGraph.url`, any image URL and every `alternates` value are made absolute against the public URL. An absolute URL is left as is.
- Without a public URL nothing is absolutized and no canonical is derived.
- A page whose `robots` contains `noindex` skips all of this (no derived canonical, `og:url` or locale). The error page and the `404.page.tsx` page are `noindex` by framework default.

## Root, layout and page merge order

Metadata is resolved page first, then each layout, then the root, and an ancestor never overrides the level below it:

1. **Static objects merge per top-level key; the page wins.** `robots` set on the root and `description` set on the page both survive; if both set `description`, the page's value is used.
2. **`openGraph` and `twitter` merge one level deep.** The root's `openGraph.siteName` survives next to the page's `openGraph.images`.
3. **Arrays are replaced, never concatenated.** The nearest level that defines `meta`, `links`, `keywords` or `openGraph.images` supplies the whole array.
4. **A `title.template` on an ancestor wraps the title below it** (see Title above).
5. **A layout or root callback returns its complete level.** Its returned fields override `child.metadata`, and fields it omits are not carried over from the child. Spread `child.metadata` when you want to keep them:

```tsx title="src/web/products/layout.tsx"
import type { LayoutConfig } from "@warlock.js/web";

export const config = {
  metadata: ({ child }) => ({
    ...child?.metadata,
    robots: "noindex,nofollow",
  }),
} satisfies LayoutConfig;
```

Typical split: the root carries sitewide defaults and the title template, a layout carries section defaults, and each page carries its own `title`, `description` and share image.

```tsx title="src/web/root.tsx"
import type { RootConfig } from "@warlock.js/web";

export const config = {
  metadata: {
    title: { default: "Acme Store", template: "%s | Acme Store" },
    openGraph: { siteName: "Acme Store" },
    twitter: { site: "@acme" },
  },
} satisfies RootConfig;
```

## Per-locale metadata

Metadata functions run inside the request, so translate with `t()` from `@warlock.js/core`. It resolves through the active locale (and the page's route-locales snapshot). See the `localize-pages` topic for the locale setup. Call `t()` inside the function, never in a module-level object, which would translate once at import time:

```tsx title="src/web/pricing.page.tsx"
import { t } from "@warlock.js/core";
import type { PageConfig } from "@warlock.js/web";

export const config = {
  route: { path: "/pricing", name: "pricing" },
  metadata: () => ({
    title: t("pricing.title"),
    description: t("pricing.description"),
  }),
} as const satisfies PageConfig;

export default function PricingPage() {
  return <h1>Pricing</h1>;
}
```

What the framework does per locale without being asked:

- `openGraph.locale` becomes the request locale and `openGraph.alternateLocales` the other locales of the page, when you do not set them.
- On a locale-routed page (a `[locale]` folder or a configured `web.localeRouting` strategy) it emits a `<link rel="alternate" hreflang>` set built by swapping the locale prefix of the current path, and a self-canonical.

### Slugs that differ per locale: `alternates`

The generated hreflang set swaps only the locale prefix. If the slug also differs per locale (`/en/apartments-for-rent-in-zamalek` against `/ar/شقق-للإيجار-في-الزمالك`), declare the real URLs with `alternates`:

```tsx
import type { PageConfig } from "@warlock.js/web";

export const config = {
  route: { path: "/listings/:id", name: "listings.show" },
  metadata: ({ data }) => ({
    alternates: {
      en: `/apartments-for-rent-in-${data.listing.slug.en}`,
      ar: `/شقق-للإيجار-في-${data.listing.slug.ar}`,
      "x-default": `/apartments-for-rent-in-${data.listing.slug.en}`,
    },
  }),
} as const satisfies PageConfig<typeof loader>;
```

- Keys are locale codes plus the optional `"x-default"`. Values are paths (joined onto the public URL like `canonical`) or absolute URLs.
- Setting `alternates` replaces the generated set entirely for that page. Nothing generated is added beside it.
- Do not also declare `links` entries with `rel: "alternate"` for the same `hreflang`; they are dropped in favour of `alternates`.

## Gotchas

- **Metadata is `config.metadata`, not a separate export.** Keep `config` a plain literal object; computed config is refused.
- **Function form needs the loader type to type `data`.** Use `PageConfig<typeof loader>` (or `LayoutConfig<typeof loader>` / `RootConfig<typeof loader>`).
- **Do not read `defer()` keys in `metadata`.** It throws `DeferredKeyInMetadataError`.
- **Editing `config.metadata` in development reloads the document**, because it changes the server-rendered head.
- **Layout and root callbacks do not inherit the child by themselves.** Spread `child.metadata`.
- **A derived `canonical` needs `app.publicUrl`.** Without it the canonical link is emitted only when you set `canonical` yourself.

## See also

- `create-a-page` topic: the full page module, `config`, caching and the error boundary.
- `load-page-data` topic: the loader whose data feeds the metadata function.
- `use-layouts` and `write-the-root` topics: `LayoutConfig`, `RootConfig` and `<Head />`.
- `localize-pages` topic: locale setup, `useTrans` and `t()`.
- `generate-sitemap` topic: hreflang alternates in `sitemap.xml`.
