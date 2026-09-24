/**
 * The `metadata` page contract, from both ends.
 *
 * ## What this file proves, and what runs it
 *
 * Half of it does not execute under vitest at all — the `@ts-expect-error`
 * cases are checked by `yarn typecheck`, and they FAIL THE BUILD when the
 * expected error stops happening. That is the point: a test asserting "this
 * does not compile" has to be run by the compiler.
 *
 * The other half executes here, and it is the grounding rule for the type:
 * every key {@link MetadataOutput} declares must produce a tag from the code
 * that actually writes `<head>`. A type promising a field nothing reads is the
 * same silence as an unknown key — the page is served without it, and nothing
 * says so.
 *
 * The build-time half of the contract — the UNANNOTATED typo, which no compiler
 * can see — lives in `build/discover-pages.spec.ts`.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentContext, type DocumentContextValue } from "./components/document-context";
import { Head } from "./components/head";
import {
  METADATA_KEYS,
  OPEN_GRAPH_KEYS,
  TWITTER_KEYS,
  type MetadataOutput,
  type PageMetadata,
} from "./metadata";
import type { LayoutConfig, RootConfig } from "./page-config";

const metadataContractLoader = async () => ({ locale: "en", title: "Home" });
const metadataContractRoot: RootConfig<typeof metadataContractLoader> = {
  metadata: ({ data }) => ({ title: data.locale }),
};
const metadataContractLayout: LayoutConfig<typeof metadataContractLoader> = {
  metadata: ({ data, child }) => ({
    title: child?.metadata.title ?? data.title,
  }),
};

// Compile-only: metadata callbacks retain concrete own loader data and child is readonly.
const metadataContractReadonlyChild: NonNullable<
  LayoutConfig<typeof metadataContractLoader>["metadata"]
> = ({ child }) => {
  if (child) {
    // @ts-expect-error child metadata cannot be mutated by an ancestor callback
    child.metadata.title = "mutated";
    if (child.metadata.openGraph) {
      // @ts-expect-error optional nested metadata is readonly too
      child.metadata.openGraph.title = "mutated";
    }
    if (child.metadata.twitter) {
      // @ts-expect-error optional nested metadata is readonly too
      child.metadata.twitter.title = "mutated";
    }
  }
  return {};
};

void metadataContractRoot;
void metadataContractReadonlyChild;

describe("PageMetadata — the annotated half", () => {
  it("rejects an unknown key by name (checked by `yarn typecheck`, not by vitest)", () => {
    // THE DEFECT, spelled the way the report that found it spelled it.
    // Remove the annotation and this compiles — which is why the build gate in
    // `build/discover-pages.ts` exists as well as this type.
    // @ts-expect-error `tittle` is not a metadata key
    const typo: PageMetadata = { tittle: "x" };

    // @ts-expect-error `titel` is not an openGraph key
    const nestedTypo: PageMetadata = { title: "x", openGraph: { titel: "x" } };

    // @ts-expect-error `cards` is not a twitter key
    const twitterTypo: PageMetadata = { twitter: { cards: "summary" } };

    // The function form is annotated the same way and checked the same way.
    // @ts-expect-error `descriptoin` is not a metadata key
    const functionTypo: PageMetadata = () => ({ descriptoin: "x" });

    expect([typo, nestedTypo, twitterTypo, functionTypo]).toHaveLength(4);
  });

  it("accepts the whole declared surface", () => {
    const full: PageMetadata = {
      title: "Products",
      description: "Everything in stock",
      keywords: ["shop", "products"],
      canonical: "https://example.com/products",
      robots: "index,follow",
      openGraph: { title: "Products", description: "d", image: "i", url: "u", type: "website" },
      twitter: { card: "summary", title: "t", description: "d", image: "i" },
    };

    expect(full).toBeTruthy();
  });
});

/** `<Head/>` on its own, which is exactly what the document's `<head>` contains. */
function renderHead(metadata: MetadataOutput): string {
  const value = { metadata, payload: {} } as unknown as DocumentContextValue;

  // The framework marks `meta[]`/`links[]` and multi-valued tags with
  // `data-warlock-metadata` so client navigation can find them; strip it so
  // assertions compare the tag itself.
  return renderToStaticMarkup(
    createElement(DocumentContext.Provider, { value }, createElement(Head)),
  ).replace(/ data-warlock-metadata="[^"]*"/g, "");
}

/**
 * Every declared key, and the tag it must produce — rendered ALONE, so a key
 * that only works next to another one still fails here.
 *
 * Asserting on the rendered output rather than on the source is the difference
 * between "the field exists" and "the field reaches the browser". Each case is
 * a metadata object that sets exactly that key (plus what it needs to be
 * emitted) and the tag that must appear in the head.
 */
type RenderCase = { metadata: MetadataOutput; tag: string };

const CASE_FOR_KEY: Record<string, RenderCase> = {
  title: { metadata: { title: "Products" }, tag: "<title>Products</title>" },
  description: {
    metadata: { description: "Everything in stock" },
    tag: '<meta name="description" content="Everything in stock"/>',
  },
  keywords: {
    metadata: { keywords: ["shop", "products"] },
    tag: '<meta name="keywords" content="shop, products"/>',
  },
  image: {
    metadata: { image: "og-image" },
    tag: '<meta property="og:image" content="og-image"/>',
  },
  authors: {
    metadata: { authors: ["Ada", "Grace"] },
    tag: '<meta name="author" content="Ada, Grace"/>',
  },
  canonical: {
    metadata: { canonical: "https://example.com/products" },
    tag: '<link rel="canonical" href="https://example.com/products"/>',
  },
  robots: {
    metadata: { robots: "index,follow" },
    tag: '<meta name="robots" content="index,follow"/>',
  },
  openGraph: {
    metadata: { openGraph: { type: "website" } },
    tag: '<meta property="og:type" content="website"/>',
  },
  twitter: {
    metadata: { twitter: { card: "summary" } },
    tag: '<meta name="twitter:card" content="summary"/>',
  },
  meta: {
    metadata: { meta: [{ name: "generator", content: "warlock" }] },
    tag: '<meta name="generator" content="warlock"',
  },
  links: {
    metadata: { links: [{ rel: "icon", href: "/favicon.ico" }] },
    tag: '<link rel="icon" href="/favicon.ico"',
  },
};

const CASE_FOR_OPEN_GRAPH_KEY: Record<string, RenderCase> = {
  // `title` and `description` fall back to the top-level fields, so they are
  // proven by overriding them.
  title: {
    metadata: { title: "T", openGraph: { title: "OG title" } },
    tag: '<meta property="og:title" content="OG title"/>',
  },
  description: {
    metadata: { description: "d", openGraph: { description: "OG description" } },
    tag: '<meta property="og:description" content="OG description"/>',
  },
  image: {
    metadata: { openGraph: { image: "og-image" } },
    tag: '<meta property="og:image" content="og-image"/>',
  },
  images: {
    metadata: { openGraph: { images: [{ url: "a.png", width: 1200 }] } },
    tag: '<meta property="og:image" content="a.png"/><meta property="og:image:width" content="1200"/>',
  },
  url: {
    metadata: { openGraph: { url: "og-url" } },
    tag: '<meta property="og:url" content="og-url"/>',
  },
  type: {
    metadata: { openGraph: { type: "product" } },
    tag: '<meta property="og:type" content="product"/>',
  },
  siteName: {
    metadata: { openGraph: { siteName: "Shop" } },
    tag: '<meta property="og:site_name" content="Shop"/>',
  },
  locale: {
    metadata: { openGraph: { locale: "en_US" } },
    tag: '<meta property="og:locale" content="en_US"/>',
  },
  alternateLocales: {
    metadata: { openGraph: { alternateLocales: ["ar"] } },
    tag: '<meta property="og:locale:alternate" content="ar"',
  },
  article: {
    metadata: { openGraph: { type: "article", article: { section: "News" } } },
    tag: '<meta property="article:section" content="News"/>',
  },
};

const CASE_FOR_TWITTER_KEY: Record<string, RenderCase> = {
  card: {
    metadata: { twitter: { card: "player" } },
    tag: '<meta name="twitter:card" content="player"/>',
  },
  title: {
    metadata: { twitter: { title: "tw-title" } },
    tag: '<meta name="twitter:title" content="tw-title"/>',
  },
  description: {
    metadata: { twitter: { description: "tw-desc" } },
    tag: '<meta name="twitter:description" content="tw-desc"/>',
  },
  image: {
    metadata: { twitter: { image: "tw-image" } },
    tag: '<meta name="twitter:image" content="tw-image"/>',
  },
  imageAlt: {
    metadata: { twitter: { imageAlt: "A shelf" } },
    tag: '<meta name="twitter:image:alt" content="A shelf"/>',
  },
  site: {
    metadata: { twitter: { site: "@shop" } },
    tag: '<meta name="twitter:site" content="@shop"/>',
  },
  creator: {
    metadata: { twitter: { creator: "@ada" } },
    tag: '<meta name="twitter:creator" content="@ada"/>',
  },
};

describe("MetadataOutput — every declared key is a key something reads", () => {
  it.each([
    ["metadata", METADATA_KEYS, CASE_FOR_KEY],
    ["openGraph", OPEN_GRAPH_KEYS, CASE_FOR_OPEN_GRAPH_KEY],
    ["twitter", TWITTER_KEYS, CASE_FOR_TWITTER_KEY],
  ] as const)("covers every %s key with a rendered tag", (_name, keys, table) => {
    // The guard on the guard: a key added to the type and the list without a
    // tag beside it fails HERE, before anyone discovers by shipping that the
    // page renders without it.
    expect(Object.keys(table).sort()).toEqual([...keys].sort());
  });

  it.each([
    ...Object.entries(CASE_FOR_KEY).map(([key, entry]) => ["metadata", key, entry] as const),
    ...Object.entries(CASE_FOR_OPEN_GRAPH_KEY).map(
      ([key, entry]) => ["openGraph", key, entry] as const,
    ),
    ...Object.entries(CASE_FOR_TWITTER_KEY).map(([key, entry]) => ["twitter", key, entry] as const),
  ])("%s.%s reaches the head", (_group, _key, entry) => {
    expect(renderHead(entry.metadata)).toContain(entry.tag);
  });

  it("writes NOTHING for a key the type does not declare — the whole reason the gate exists", () => {
    // The unannotated typo, rendered. No `<title>`; no error; no trace of
    // `tittle` anywhere in the output. This is what a page ships as today
    // without the build gate in `build/discover-pages.ts`.
    const html = renderHead({ tittle: "Products" } as unknown as MetadataOutput);

    expect(html).toBe('<meta charSet="utf-8"/>');
    expect(html).not.toContain("tittle");
    expect(html).not.toContain("Products");
  });
});
