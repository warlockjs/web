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

  return renderToStaticMarkup(
    createElement(DocumentContext.Provider, { value }, createElement(Head)),
  );
}

/**
 * Every declared key, and the tag it must produce.
 *
 * These strings are not composed from the type — they were READ OFF A REAL
 * RESPONSE. A page exporting this exact metadata object was served over
 * node:http and the bytes that came back carried precisely these tags, in this
 * order, with `og:title`/`og:description` filled from the top-level fields
 * exactly as `metadata.ts` documents. Asserting on the rendered output rather
 * than on the source is the difference between "the field exists" and "the
 * field reaches the browser".
 */
const FULL_METADATA: MetadataOutput = {
  title: "Products",
  description: "Everything in stock",
  keywords: ["shop", "products"],
  canonical: "https://example.com/products",
  robots: "index,follow",
  openGraph: { image: "og-image", url: "og-url", type: "website" },
  twitter: { card: "summary", title: "tw-title", description: "tw-desc", image: "tw-image" },
};

const TAG_FOR_KEY: Record<string, string> = {
  title: "<title>Products</title>",
  description: '<meta name="description" content="Everything in stock"/>',
  keywords: '<meta name="keywords" content="shop, products"/>',
  canonical: '<link rel="canonical" href="https://example.com/products"/>',
  robots: '<meta name="robots" content="index,follow"/>',
  openGraph: '<meta property="og:type" content="website"/>',
  twitter: '<meta name="twitter:card" content="summary"/>',
};

const TAG_FOR_OPEN_GRAPH_KEY: Record<string, string> = {
  // `title` and `description` fall back to the top-level fields — the only two
  // fallbacks the type declares, and they are why this object omits them.
  title: '<meta property="og:title" content="Products"/>',
  description: '<meta property="og:description" content="Everything in stock"/>',
  image: '<meta property="og:image" content="og-image"/>',
  url: '<meta property="og:url" content="og-url"/>',
  type: '<meta property="og:type" content="website"/>',
};

const TAG_FOR_TWITTER_KEY: Record<string, string> = {
  card: '<meta name="twitter:card" content="summary"/>',
  title: '<meta name="twitter:title" content="tw-title"/>',
  description: '<meta name="twitter:description" content="tw-desc"/>',
  image: '<meta name="twitter:image" content="tw-image"/>',
};

describe("MetadataOutput — every declared key is a key something reads", () => {
  it.each([
    ["metadata", METADATA_KEYS, TAG_FOR_KEY],
    ["openGraph", OPEN_GRAPH_KEYS, TAG_FOR_OPEN_GRAPH_KEY],
    ["twitter", TWITTER_KEYS, TAG_FOR_TWITTER_KEY],
  ] as const)("covers every %s key with a rendered tag", (_name, keys, table) => {
    // The guard on the guard: a key added to the type and the list without a
    // tag beside it fails HERE, before anyone discovers by shipping that the
    // page renders without it.
    expect(Object.keys(table).sort()).toEqual([...keys].sort());
  });

  it("renders the tag for every key, in the order the response carried them", () => {
    const html = renderHead(FULL_METADATA);
    const expected = [
      '<meta charSet="utf-8"/>',
      TAG_FOR_KEY.title,
      TAG_FOR_KEY.description,
      TAG_FOR_KEY.keywords,
      TAG_FOR_KEY.canonical,
      TAG_FOR_KEY.robots,
      TAG_FOR_OPEN_GRAPH_KEY.title,
      TAG_FOR_OPEN_GRAPH_KEY.description,
      TAG_FOR_OPEN_GRAPH_KEY.image,
      TAG_FOR_OPEN_GRAPH_KEY.url,
      TAG_FOR_OPEN_GRAPH_KEY.type,
      TAG_FOR_TWITTER_KEY.card,
      TAG_FOR_TWITTER_KEY.title,
      TAG_FOR_TWITTER_KEY.description,
      TAG_FOR_TWITTER_KEY.image,
    ].join("");

    expect(html).toBe(expected);
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
