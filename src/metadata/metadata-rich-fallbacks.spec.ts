/**
 * The context-free fallbacks `resolveMetadataDescriptors` applies for both
 * `<Head/>` and the client navigation applier: og/twitter derived from the
 * top-level fields, images, article tags and authors.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentContext, type DocumentContextValue } from "../components/document-context";
import { Head } from "../components/head";
import type { MetadataOutput } from "../metadata";

function renderHead(metadata: MetadataOutput | undefined): string {
  const value = { metadata, payload: {} } as unknown as DocumentContextValue;

  // The framework marks `meta[]`/`links[]` and multi-valued tags with
  // `data-warlock-metadata` so client navigation can find them; strip it so
  // assertions compare the tag itself.
  return renderToStaticMarkup(
    createElement(DocumentContext.Provider, { value }, createElement(Head)),
  ).replace(/ data-warlock-metadata="[^"]*"/g, "");
}

describe("rich metadata fallbacks", () => {
  it("title + description + image alone produce the og and twitter tags", () => {
    const html = renderHead({
      title: "Shop",
      description: "All of it",
      image: "https://a.test/i.png",
    });

    for (const tag of [
      '<meta property="og:title" content="Shop"/>',
      '<meta property="og:description" content="All of it"/>',
      '<meta property="og:image" content="https://a.test/i.png"',
      '<meta property="og:type" content="website"/>',
      '<meta name="twitter:card" content="summary_large_image"/>',
      '<meta name="twitter:title" content="Shop"/>',
      '<meta name="twitter:description" content="All of it"/>',
      '<meta name="twitter:image" content="https://a.test/i.png"/>',
    ]) {
      expect(html).toContain(tag);
    }
  });

  it("an explicit twitter.title beats the og fallback", () => {
    const html = renderHead({
      title: "Shop",
      openGraph: { title: "OG Shop" },
      twitter: { title: "Tweet" },
    });

    expect(html).toContain('<meta name="twitter:title" content="Tweet"/>');
    expect(html).toContain('<meta property="og:title" content="OG Shop"/>');
  });

  it("twitter falls back to the og value when it sets nothing itself", () => {
    const html = renderHead({ title: "Shop", openGraph: { title: "OG Shop" } });

    expect(html).toContain('<meta name="twitter:title" content="OG Shop"/>');
  });

  it("no image means twitter:card=summary", () => {
    const html = renderHead({ title: "Shop" });

    expect(html).toContain('<meta name="twitter:card" content="summary"/>');
    expect(html).not.toContain("og:image");
    expect(html).not.toContain("twitter:image");
  });

  it("emits no og or twitter tag for a page with no title, description or image", () => {
    const html = renderHead({ robots: "noindex" });

    expect(html).not.toContain("og:");
    expect(html).not.toContain("twitter:");
  });

  it("openGraph.images win over openGraph.image and image, and carry their sub-properties", () => {
    const html = renderHead({
      image: "top.png",
      openGraph: {
        image: "old.png",
        images: [
          { url: "a.png", width: 1200, height: 630, alt: "A", type: "image/png" },
          { url: "b.png" },
        ],
      },
    });

    expect(html).toContain(
      '<meta property="og:image" content="a.png"/>' +
        '<meta property="og:image:width" content="1200"/>' +
        '<meta property="og:image:height" content="630"/>' +
        '<meta property="og:image:alt" content="A"/>' +
        '<meta property="og:image:type" content="image/png"/>' +
        '<meta property="og:image" content="b.png"/>',
    );
    expect(html).not.toContain("top.png");
    expect(html).not.toContain("old.png");
    expect(html).toContain('<meta name="twitter:image" content="a.png"/>');
    expect(html).toContain('<meta name="twitter:image:alt" content="A"/>');
  });

  it("an object image is normalized", () => {
    const html = renderHead({ image: { url: "a.png", alt: "Alt" } });

    expect(html).toContain('<meta property="og:image" content="a.png"/>');
    expect(html).toContain('<meta property="og:image:alt" content="Alt"/>');
  });

  it("og:site_name, og:type and twitter site/creator are emitted as given", () => {
    const html = renderHead({
      openGraph: { siteName: "Shop", type: "product" },
      twitter: { site: "@shop", creator: "@ada" },
    });

    expect(html).toContain('<meta property="og:site_name" content="Shop"/>');
    expect(html).toContain('<meta property="og:type" content="product"/>');
    expect(html).toContain('<meta name="twitter:site" content="@shop"/>');
    expect(html).toContain('<meta name="twitter:creator" content="@ada"/>');
  });

  it("type=article emits the article:* tags, one per author and tag", () => {
    const html = renderHead({
      title: "Post",
      openGraph: {
        type: "article",
        article: {
          publishedTime: "2026-01-01",
          modifiedTime: "2026-02-01",
          section: "News",
          authors: ["https://a.test/ada", "https://a.test/grace"],
          tags: ["x", "y"],
        },
      },
    });

    for (const tag of [
      '<meta property="og:type" content="article"/>',
      '<meta property="article:published_time" content="2026-01-01"/>',
      '<meta property="article:modified_time" content="2026-02-01"/>',
      '<meta property="article:section" content="News"/>',
      '<meta property="article:author" content="https://a.test/ada"',
      '<meta property="article:author" content="https://a.test/grace"',
      '<meta property="article:tag" content="x"',
      '<meta property="article:tag" content="y"',
    ]) {
      expect(html).toContain(tag);
    }
  });

  it("article:* tags are not emitted for a non-article type", () => {
    const html = renderHead({ openGraph: { type: "website", article: { section: "News" } } });

    expect(html).not.toContain("article:");
  });

  it("authors render one meta author and a link rel=author per author with a url", () => {
    const html = renderHead({
      authors: ["Ada", { name: "Grace", url: "https://a.test/grace" }],
    });

    expect(html).toContain('<meta name="author" content="Ada, Grace"/>');
    expect(html).toContain('<link rel="author" href="https://a.test/grace"');
    expect(html.match(/rel="author"/g)).toHaveLength(1);
  });

  it("canonical: false renders no canonical link", () => {
    expect(renderHead({ title: "x", canonical: false })).not.toContain('rel="canonical"');
  });

  it("built-in slots beat metadata.meta entries", () => {
    const html = renderHead({
      authors: "Ada",
      meta: [
        { name: "author", content: "Other" },
        { property: "og:image", content: "x.png" },
        { property: "article:tag", content: "t" },
        { name: "twitter:site", content: "@x" },
      ],
    });

    expect(html).not.toContain("Other");
    expect(html).not.toContain("x.png");
    expect(html).not.toContain('content="t"');
    expect(html).not.toContain("@x");
  });
});
