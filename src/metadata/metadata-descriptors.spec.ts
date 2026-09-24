/**
 * Parity between the two `<head>` renderers.
 *
 * `components/head.ts` (SSR, first render) and
 * `client/navigation/document-metadata.ts` (SPA navigation, every render
 * after) both turn `MetadataOutput` into tags — and they have to agree,
 * because nothing tells a visitor which one produced the head they are
 * looking at. This suite renders BOTH paths for real (`renderToStaticMarkup`
 * for SSR, the actual DOM-writing function against a fake document for the
 * client) and compares their output in a shared, tag-agnostic format. It
 * does not call `resolveMetadataDescriptors` and assert against itself —
 * that would prove the function agrees with itself, not that the two
 * consumers do.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { applyDocumentMetadata } from "../client/navigation/document-metadata";
import { DocumentContext, type DocumentContextValue } from "../components/document-context";
import { Head } from "../components/head";
import type { MetadataOutput } from "../metadata";

/** The three tag shapes either path can produce, described the same way regardless of source. */
function describeMetaTag(attributes: Record<string, string | undefined>): string {
  const attribute = attributes.name !== undefined ? "name" : "property";
  const name = attributes.name ?? attributes.property;

  return `meta ${attribute}=${name} content=${attributes.content}`;
}

/** `<Head/>`, rendered for real and parsed back into the shared description format, in document order. */
function renderedBySsr(metadata: MetadataOutput | undefined): string[] {
  const value = { metadata, payload: {} } as unknown as DocumentContextValue;
  const html = renderToStaticMarkup(
    createElement(DocumentContext.Provider, { value }, createElement(Head)),
  );

  const tagPattern = /<title>([^<]*)<\/title>|<meta([^>]*)\/>|<link([^>]*)\/>/g;
  const results: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(html)) !== null) {
    const [, titleText, metaAttrs, linkAttrs] = match;

    if (titleText !== undefined) {
      results.push(`title ${titleText}`);
      continue;
    }

    if (metaAttrs !== undefined) {
      if (metaAttrs.includes("charSet")) continue; // unconditional, not page metadata

      results.push(
        describeMetaTag({
          name: /\bname="([^"]*)"/.exec(metaAttrs)?.[1],
          property: /\bproperty="([^"]*)"/.exec(metaAttrs)?.[1],
          content: /\bcontent="([^"]*)"/.exec(metaAttrs)?.[1],
        }),
      );
      continue;
    }

    if (linkAttrs !== undefined) {
      const rel = /\brel="([^"]*)"/.exec(linkAttrs)?.[1];
      const href = /\bhref="([^"]*)"/.exec(linkAttrs)?.[1];

      if (rel === "stylesheet") continue; // not page metadata

      results.push(`link rel=${rel} href=${href}`);
    }
  }

  return results;
}

type FakeElement = {
  tagName: string;
  attributes: Record<string, string>;
  textContent: string;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  getAttributeNames(): string[];
  removeAttribute(name: string): void;
  remove(): void;
};

const SELECTOR_PATTERN = /^([a-z]+)(?:\[([a-zA-Z-]+)="([^"]+)"\])?$/;

function matchesSelector(element: FakeElement, selector: string): boolean {
  const parsed = SELECTOR_PATTERN.exec(selector);

  if (!parsed) throw new Error(`Unsupported selector: ${selector}`);

  const [, tagName, attribute, value] = parsed;

  if (element.tagName !== tagName) return false;
  if (attribute === undefined) return true;

  return element.attributes[attribute] === value;
}

function fakeDocument() {
  const elements: FakeElement[] = [];

  const make = (tagName: string): FakeElement => {
    const element: FakeElement = {
      tagName,
      attributes: {},
      textContent: "",
      setAttribute(name, value) {
        element.attributes[name] = value;
      },
      getAttribute: (name) => element.attributes[name] ?? null,
      getAttributeNames: () => Object.keys(element.attributes),
      removeAttribute(name) {
        delete element.attributes[name];
      },
      remove() {
        const index = elements.indexOf(element);

        if (index >= 0) elements.splice(index, 1);
      },
    };

    return element;
  };

  const documentNode = {
    head: {
      appendChild(element: FakeElement) {
        elements.push(element);
      },
    },
    createElement: (tagName: string) => make(tagName),
    querySelector: (selector: string) =>
      elements.find((element) => matchesSelector(element, selector)) ?? null,
    // Only the `[attribute]` shape the applier uses to find its dynamic tags.
    querySelectorAll: (selector: string) => {
      const attribute = /^\[([a-zA-Z-]+)\]$/.exec(selector)?.[1];

      if (attribute === undefined) throw new Error(`Unsupported selector: ${selector}`);

      return elements.filter((element) => attribute in element.attributes);
    },
  } as unknown as Document;

  return { documentNode, elements };
}

function describeElement(element: FakeElement): string {
  if (element.tagName === "title") return `title ${element.textContent}`;
  if (element.tagName === "meta") return describeMetaTag(element.attributes);

  return `link rel=${element.attributes.rel} href=${element.attributes.href}`;
}

/** `applyDocumentMetadata` against a fresh (empty) `<head>` — the first navigation's shape. */
function appliedByClient(metadata: MetadataOutput | undefined): string[] {
  const { documentNode, elements } = fakeDocument();

  applyDocumentMetadata(documentNode, metadata);

  return elements.map(describeElement);
}

const TITLE_ONLY: MetadataOutput = { title: "Contact us" };
const TITLE_AND_DESCRIPTION: MetadataOutput = {
  title: "Contact us",
  description: "How to reach us",
};
const EXPLICIT_OG_OVERRIDE: MetadataOutput = {
  title: "Contact us",
  description: "How to reach us",
  openGraph: { title: "Talk to us", description: "We are here to help" },
};
const TWITTER_DOES_NOT_FALL_BACK_TO_OG: MetadataOutput = {
  title: "Contact us",
  openGraph: { image: "https://app.test/og.png" },
  twitter: { card: "summary" },
};
const CANONICAL: MetadataOutput = { canonical: "https://app.test/contact-us" };
const ALL_FIELDS: MetadataOutput = {
  title: "Contact us",
  description: "How to reach us",
  keywords: ["support", "contact"],
  canonical: "https://app.test/contact-us",
  robots: "index, follow",
  openGraph: {
    title: "Talk to us",
    description: "We are here to help",
    image: "https://app.test/og.png",
    url: "https://app.test/contact-us",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Talk to us on Twitter",
    description: "DM us any time",
    image: "https://app.test/twitter.png",
  },
};

/**
 * Decodes the HTML entities `renderToStaticMarkup` produces in text/attribute
 * content (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#x27;`) back to the raw
 * characters. SSR output is HTML source, so React escapes it — the client
 * writes through `textContent`/`setAttribute`, DOM APIs that take raw
 * characters and need no such escaping. Comparing the two fairly means
 * decoding SSR's escaped form back to the same raw value the client holds,
 * not asserting the two serialize identically.
 */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}

function renderedBySsrDecoded(metadata: MetadataOutput | undefined): string[] {
  return renderedBySsr(metadata).map(decodeHtmlEntities);
}

describe("SSR/client metadata parity", () => {
  it.each([
    ["title only", TITLE_ONLY],
    ["title + description", TITLE_AND_DESCRIPTION],
    ["explicit og overriding the top-level fields", EXPLICIT_OG_OVERRIDE],
    [
      "twitter set alongside og — twitter members fall back to the og values",
      TWITTER_DOES_NOT_FALL_BACK_TO_OG,
    ],
    ["canonical", CANONICAL],
    ["every managed field set at once", ALL_FIELDS],
    ["no metadata at all", undefined],
  ] as const)("%s: the client applies exactly what SSR rendered", (_name, metadata) => {
    expect(appliedByClient(metadata)).toEqual(renderedBySsr(metadata));
  });

  /**
   * The case the whole spec exists for: a key one page sets and the next does
   * not. The client only ever sees a DIFF against whatever the previous page
   * left in `<head>`; this proves the diff still lands on the same tags a
   * fresh SSR of the second page would have produced.
   */
  it("a key present on one page and absent on the next: navigating there matches a fresh SSR of it", () => {
    const { documentNode, elements } = fakeDocument();

    applyDocumentMetadata(documentNode, EXPLICIT_OG_OVERRIDE); // first navigation: sets description + og
    applyDocumentMetadata(documentNode, TITLE_ONLY); // next navigation: description + og no longer set

    expect(elements.map(describeElement)).toEqual(renderedBySsr(TITLE_ONLY));
  });

  /**
   * `MANAGED_METADATA_KEYS`' order is the ONE order either path can ever
   * produce (`resolveMetadataDescriptors` walks it top to bottom, and the
   * client applier walks the same list to know what to remove) — so with
   * every managed field set, both outputs must land in that exact sequence,
   * not merely as equal sets.
   */
  it("document order: with every field set, SSR and the client emit tags in the same sequence", () => {
    const client = appliedByClient(ALL_FIELDS);
    const ssr = renderedBySsr(ALL_FIELDS);

    expect(client).toEqual(ssr);
    expect(client).toEqual([
      "title Contact us",
      "meta name=description content=How to reach us",
      "meta name=keywords content=support, contact",
      "link rel=canonical href=https://app.test/contact-us",
      "meta name=robots content=index, follow",
      "meta property=og:title content=Talk to us",
      "meta property=og:description content=We are here to help",
      "meta property=og:url content=https://app.test/contact-us",
      "meta property=og:type content=website",
      "meta name=twitter:card content=summary",
      "meta name=twitter:title content=Talk to us on Twitter",
      "meta name=twitter:description content=DM us any time",
      "meta name=twitter:image content=https://app.test/twitter.png",
      // Repeatable built-ins are dynamic tags: after every fixed slot.
      "meta property=og:image content=https://app.test/og.png",
    ]);
  });

  /**
   * The dedupe guarantee `applyDocumentMetadata` gives per key: a second
   * navigation that still fills the same slot must UPDATE the one element
   * already there, never append a second one alongside it. Without this,
   * every navigation that keeps the same key would leave one more stale tag
   * in `<head>` than the one before it.
   */
  it("deduplication: navigating twice with the same key present updates one tag, not two", () => {
    const { documentNode, elements } = fakeDocument();

    applyDocumentMetadata(documentNode, TITLE_AND_DESCRIPTION);
    applyDocumentMetadata(documentNode, {
      title: "Contact us",
      description: "A different way to reach us",
    });

    const descriptionTags = elements.filter(
      (element) => element.tagName === "meta" && element.attributes.name === "description",
    );

    expect(descriptionTags).toHaveLength(1);
    expect(elements.map(describeElement)).toEqual(
      renderedBySsr({ title: "Contact us", description: "A different way to reach us" }),
    );
  });

  /** Re-rendering the SAME metadata (e.g. a re-render with no navigation) must also not duplicate. */
  it("deduplication: applying identical metadata twice leaves the tag count unchanged", () => {
    const { documentNode, elements } = fakeDocument();

    applyDocumentMetadata(documentNode, ALL_FIELDS);
    const countAfterFirst = elements.length;

    applyDocumentMetadata(documentNode, ALL_FIELDS);

    expect(elements).toHaveLength(countAfterFirst);
  });

  /**
   * `<`, `"` and `&` in title/description text. SSR is HTML source and MUST
   * escape them (`&` unescaped would corrupt the markup, `<` would open a
   * bogus tag); the client writes through `textContent`/`setAttribute`,
   * which take the raw characters directly and need no escaping of their
   * own. `renderedBySsrDecoded` undoes SSR's escaping so the comparison is
   * over the actual characters landing in the document either way, which is
   * the thing a reader of the page — or a share-preview scraper reading the
   * meta tag — actually sees.
   */
  it("escaping: '<', '\"' and '&' in title/description reach the document identically on both paths", () => {
    const DANGEROUS: MetadataOutput = {
      title: `Contact us & "support" <team>`,
      description: `We're here 24/7 & we <care> a lot, "really"`,
    };

    expect(appliedByClient(DANGEROUS)).toEqual(renderedBySsrDecoded(DANGEROUS));
    expect(appliedByClient(DANGEROUS)).toEqual([
      `title Contact us & "support" <team>`,
      `meta name=description content=We're here 24/7 & we <care> a lot, "really"`,
      // og:*/twitter:* always fall back to title/description (5.20).
      `meta property=og:title content=Contact us & "support" <team>`,
      `meta property=og:description content=We're here 24/7 & we <care> a lot, "really"`,
      "meta property=og:type content=website",
      "meta name=twitter:card content=summary",
      `meta name=twitter:title content=Contact us & "support" <team>`,
      `meta name=twitter:description content=We're here 24/7 & we <care> a lot, "really"`,
    ]);
  });
});
