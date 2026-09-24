/**
 * `metadata.meta` / `metadata.links`: server render, client navigation and
 * the root → layout → page merge.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyDocumentMetadata } from "../client/navigation/document-metadata";
import { DocumentContext, type DocumentContextValue } from "../components/document-context";
import { Head } from "../components/head";
import type { MetadataOutput } from "../metadata";
import { resolvePageMetadata } from "../server/resolve-page-metadata";
import { MANAGED_DYNAMIC_ATTRIBUTE } from "./metadata-descriptors";

function renderHead(metadata: MetadataOutput | undefined): string {
  const value = { metadata, payload: {} } as unknown as DocumentContextValue;

  return renderToStaticMarkup(
    createElement(DocumentContext.Provider, { value }, createElement(Head)),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("metadata.meta / metadata.links — server render", () => {
  it("renders name, property and http-equiv metas", () => {
    const html = renderHead({
      meta: [
        { name: "generator", content: "Ada" },
        { property: "fb:app_id", content: "News" },
        { httpEquiv: "x-ua-compatible", content: "IE=edge" },
      ],
    });

    expect(html).toContain('<meta name="generator" content="Ada"');
    expect(html).toContain('<meta property="fb:app_id" content="News"');
    expect(html).toContain('<meta http-equiv="x-ua-compatible" content="IE=edge"');
  });

  it("renders every allowlisted link attribute", () => {
    const html = renderHead({
      links: [
        {
          rel: "alternate",
          href: "https://app.test/ar",
          hreflang: "ar",
          type: "text/html",
          sizes: "16x16",
          media: "print",
          as: "style",
          crossOrigin: "anonymous",
          title: "Arabic",
        },
      ],
    });

    for (const fragment of [
      'rel="alternate"',
      'href="https://app.test/ar"',
      'hrefLang="ar"',
      'type="text/html"',
      'sizes="16x16"',
      'media="print"',
      'as="style"',
      'crossorigin="anonymous"',
      'title="Arabic"',
    ]) {
      expect(html).toContain(fragment);
    }
  });

  it("escapes quotes and '<' in values", () => {
    const html = renderHead({
      meta: [{ name: "x", content: `a "quoted" <b>` }],
      links: [{ rel: "preload", href: `/a"b<c` }],
    });

    expect(html).not.toContain('"quoted"');
    expect(html).not.toContain("<b>");
    expect(html).toContain("&quot;quoted&quot;");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("/a&quot;b&lt;c");
  });

  it("drops a bad rel and a javascript: href, with a dev warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = renderHead({
      links: [
        { rel: 'x" onload="y', href: "/a" },
        { rel: "preload", href: " JavaScript:alert(1)" },
        { rel: "preload", href: "/ok" },
      ],
    });

    expect(html).not.toContain("onload");
    expect(html).not.toContain("alert");
    expect(html).toContain('href="/ok"');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("a built-in description beats meta: [{ name: 'description' }]", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = renderHead({
      description: "built-in",
      meta: [{ name: "description", content: "from meta[]" }],
    });

    expect(html).toContain('content="built-in"');
    expect(html).not.toContain("from meta[]");
  });
});

/** Just enough DOM for the applier: attribute-selector lookups over a flat head. */
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

function fakeDocument() {
  const elements: FakeElement[] = [];

  const make = (tagName: string): FakeElement => {
    const element: FakeElement = {
      tagName,
      attributes: {},
      textContent: "",
      setAttribute: (name, value) => void (element.attributes[name] = value),
      getAttribute: (name) => element.attributes[name] ?? null,
      getAttributeNames: () => Object.keys(element.attributes),
      removeAttribute: (name) => void delete element.attributes[name],
      remove() {
        const index = elements.indexOf(element);

        if (index >= 0) elements.splice(index, 1);
      },
    };

    return element;
  };

  const matches = (element: FakeElement, selector: string): boolean => {
    const tag = /^[a-z]+/.exec(selector)?.[0];
    const attributePairs = [...selector.matchAll(/\[([a-zA-Z-]+)(?:="((?:[^"\\]|\\.)*)")?\]/g)];

    if (tag !== undefined && element.tagName !== tag) return false;

    return attributePairs.every(([, name, value]) =>
      value === undefined
        ? element.attributes[name!] !== undefined
        : element.attributes[name!] === value.replace(/\\(.)/g, "$1"),
    );
  };

  const documentNode = {
    head: { appendChild: (element: FakeElement) => void elements.push(element) },
    createElement: make,
    querySelector: (selector: string) => elements.find((e) => matches(e, selector)) ?? null,
    querySelectorAll: (selector: string) => elements.filter((e) => matches(e, selector)),
  } as unknown as Document;

  return { documentNode, elements, make };
}

describe("metadata.meta / metadata.links — client navigation", () => {
  it("page A (meta x, link y) → page B (meta z) leaves z only; unmanaged tags survive", () => {
    const { documentNode, elements, make } = fakeDocument();

    const rootMeta = make("meta");
    rootMeta.setAttribute("name", "viewport");
    rootMeta.setAttribute("content", "width=device-width");
    const rootLink = make("link");
    rootLink.setAttribute("rel", "icon");
    rootLink.setAttribute("href", "/favicon.ico");
    elements.push(rootMeta, rootLink);

    applyDocumentMetadata(documentNode, {
      meta: [{ name: "x", content: "1" }],
      links: [{ rel: "alternate", href: "/y", hreflang: "ar" }],
    });

    expect(elements).toHaveLength(4);

    applyDocumentMetadata(documentNode, { meta: [{ name: "z", content: "2" }] });

    const managed = elements.filter((e) => e.attributes[MANAGED_DYNAMIC_ATTRIBUTE] !== undefined);

    expect(managed).toHaveLength(1);
    expect(managed[0]?.attributes).toMatchObject({ name: "z", content: "2" });
    expect(elements).toContain(rootMeta);
    expect(elements).toContain(rootLink);
    expect(rootMeta.attributes).toEqual({ name: "viewport", content: "width=device-width" });
  });

  it("replaces a tag in place when the same key changes, without duplicating it", () => {
    const { documentNode, elements } = fakeDocument();

    applyDocumentMetadata(documentNode, { meta: [{ name: "x", content: "1" }] });
    applyDocumentMetadata(documentNode, { meta: [{ name: "x", content: "2" }] });

    expect(elements).toHaveLength(1);
    expect(elements[0]?.attributes.content).toBe("2");
  });
});

describe("metadata.links — merge", () => {
  it("page links replace layout links (not concatenated)", () => {
    const { metadata } = resolvePageMetadata({
      metadata: { links: [{ rel: "preload", href: "/page" }] },
      ancestors: [
        {
          kind: "layout",
          metadata: { links: [{ rel: "preload", href: "/layout" }] },
          data: undefined,
        },
      ],
      data: undefined,
      error: undefined,
      failed: false,
      shared: {} as never,
      pagePath: "/",
    });

    expect(metadata?.links).toEqual([{ rel: "preload", href: "/page" }]);
  });
});
