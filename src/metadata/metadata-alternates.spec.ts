/**
 * `metadata.alternates` (real-estate #22): replaces the generated locale
 * alternates for a page, and travels through client navigation the same way
 * any other `metadata` field does — via `resolveMetadataDescriptors`, the
 * ordered list both `<Head/>` and the client applier render from.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyDocumentMetadata } from "../client/navigation/document-metadata";
import { DocumentContext, type DocumentContextValue } from "../components/document-context";
import { Head } from "../components/head";
import type { MetadataOutput } from "../metadata";
import { MANAGED_DYNAMIC_ATTRIBUTE } from "./metadata-descriptors";

function renderHead(metadata: MetadataOutput | undefined): string {
  const value = { metadata, payload: {} } as unknown as DocumentContextValue;

  return renderToStaticMarkup(
    createElement(DocumentContext.Provider, { value }, createElement(Head)),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("metadata.alternates — server render", () => {
  it("renders one link per entry, x-default included when provided", () => {
    const html = renderHead({
      alternates: {
        en: "https://app.test/apartments-for-rent-in-zamalek",
        ar: "https://app.test/شقق-للإيجار-في-الزمالك",
        "x-default": "https://app.test/apartments-for-rent-in-zamalek",
      },
    });

    expect(html).toContain(
      '<link rel="alternate" href="https://app.test/apartments-for-rent-in-zamalek" hrefLang="en"',
    );
    expect(html).toContain(
      '<link rel="alternate" href="https://app.test/شقق-للإيجار-في-الزمالك" hrefLang="ar"',
    );
    expect(html).toContain(
      '<link rel="alternate" href="https://app.test/apartments-for-rent-in-zamalek" hrefLang="x-default"',
    );
  });

  it("a matching metadata.links alternate entry is dropped in favor of alternates, with a dev warning", () => {
    vi.stubEnv("DEV", true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const html = renderHead({
      links: [{ rel: "alternate", href: "/wrong-same-slug", hreflang: "ar" }],
      alternates: { ar: "https://app.test/شقق-للإيجار-في-الزمالك" },
    });

    expect(html).not.toContain("/wrong-same-slug");
    expect(html).toContain('href="https://app.test/شقق-للإيجار-في-الزمالك"');
    expect(warn).toHaveBeenCalledTimes(1);
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

  return { documentNode, elements };
}

describe("metadata.alternates — client navigation", () => {
  it("navigating to a page with alternates writes its hreflang links", () => {
    const { documentNode, elements } = fakeDocument();

    applyDocumentMetadata(documentNode, {
      alternates: { en: "https://app.test/en-slug", ar: "https://app.test/ar-slug" },
    });

    const links = elements.filter((e) => e.tagName === "link");

    expect(links).toHaveLength(2);
    expect(links.map((l) => l.attributes.hreflang).sort()).toEqual(["ar", "en"]);
  });

  it("a previous page's alternates do not linger after navigating to a page without overrides", () => {
    const { documentNode, elements } = fakeDocument();

    applyDocumentMetadata(documentNode, {
      alternates: { en: "https://app.test/en-slug", ar: "https://app.test/ar-slug" },
    });
    expect(elements.filter((e) => e.tagName === "link")).toHaveLength(2);

    applyDocumentMetadata(documentNode, { title: "Next page" });

    const managedLinks = elements.filter(
      (e) => e.tagName === "link" && e.attributes[MANAGED_DYNAMIC_ATTRIBUTE] !== undefined,
    );

    expect(managedLinks).toHaveLength(0);
  });

  it("navigating between two pages with alternates replaces the set instead of accumulating it", () => {
    const { documentNode, elements } = fakeDocument();

    applyDocumentMetadata(documentNode, { alternates: { en: "https://app.test/a-en" } });
    applyDocumentMetadata(documentNode, {
      alternates: { en: "https://app.test/b-en", ar: "https://app.test/b-ar" },
    });

    const links = elements.filter((e) => e.tagName === "link");

    expect(links).toHaveLength(2);
    expect(links.find((l) => l.attributes.hreflang === "en")?.attributes.href).toBe(
      "https://app.test/b-en",
    );
  });
});
