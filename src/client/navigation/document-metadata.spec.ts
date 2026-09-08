import { describe, expect, it } from "vitest";
import { applyDocumentMetadata } from "./document-metadata";

/**
 * `applyDocumentMetadata` — the half of the title bug that was never about the
 * wire.
 *
 * The payload carrying metadata is necessary and not sufficient: `<head>` is
 * rendered by `<Head/>` at the App level, and the App level is deliberately NOT
 * part of the hydrated tree (`client/build-hydrated-tree.ts`'s header) — the
 * client mounts at `#root`, inside the body. So no React render on the client
 * can reach the head, and a swap has to write it imperatively or not at all.
 *
 * The suite has no DOM (node environment), so the cases below run against a
 * fake document in the shape `hydration-payload.spec.ts` already uses for the
 * payload script. That is enough to prove the RULES — set, update, and
 * especially REMOVE — and not enough to prove the browser does what we think;
 * the title change is browser-verified separately.
 */

type FakeElement = {
  tagName: string;
  attributes: Record<string, string>;
  textContent: string;
  setAttribute(name: string, value: string): void;
  remove(): void;
};

/** Only the four selector shapes the applier uses. Anything else is a bug. */
const SELECTOR_PATTERN = /^([a-z]+)(?:\[([a-zA-Z-]+)="([^"]+)"\])?$/;

function matchesSelector(element: FakeElement, selector: string): boolean {
  const parsed = SELECTOR_PATTERN.exec(selector);

  if (!parsed) throw new Error(`The applier used an unsupported selector: ${selector}`);

  const [, tagName, attribute, value] = parsed;

  if (element.tagName !== tagName) return false;
  if (attribute === undefined) return true;

  return element.attributes[attribute] === value;
}

function fakeHead(
  initial: readonly {
    tagName: string;
    attributes?: Record<string, string>;
    textContent?: string;
  }[],
) {
  const elements: FakeElement[] = [];

  const make = (
    tagName: string,
    attributes: Record<string, string> = {},
    textContent = "",
  ): FakeElement => {
    const element: FakeElement = {
      tagName,
      attributes: { ...attributes },
      textContent,
      setAttribute(name, value) {
        element.attributes[name] = value;
      },
      remove() {
        const index = elements.indexOf(element);

        if (index >= 0) elements.splice(index, 1);
      },
    };

    return element;
  };

  for (const entry of initial) {
    elements.push(make(entry.tagName, entry.attributes, entry.textContent));
  }

  const documentNode = {
    head: {
      appendChild(element: FakeElement) {
        elements.push(element);
      },
    },
    createElement: (tagName: string) => make(tagName),
    querySelector: (selector: string) =>
      elements.find((element) => matchesSelector(element, selector)) ?? null,
  } as unknown as Document;

  return { documentNode, elements };
}

/** What the head says now, in the terms the assertions are written in. */
function describeHead(elements: readonly FakeElement[]): string[] {
  return elements.map((element) => {
    const attributes = Object.entries(element.attributes)
      .map(([name, value]) => `${name}=${value}`)
      .join(" ");

    return [element.tagName, attributes, element.textContent].filter(Boolean).join(" ");
  });
}

describe("applyDocumentMetadata", () => {
  /** THE bug: / -> /contact-us swapped the body and left the title reading "Home". */
  it("writes the new page's title into the existing title element", () => {
    const { documentNode, elements } = fakeHead([{ tagName: "title", textContent: "Home" }]);

    applyDocumentMetadata(documentNode, { title: "Contact us" });

    expect(describeHead(elements)).toEqual(["title Contact us"]);
  });

  it("creates a title element when the document has none", () => {
    const { documentNode, elements } = fakeHead([]);

    applyDocumentMetadata(documentNode, { title: "Contact us" });

    expect(describeHead(elements)).toEqual(["title Contact us"]);
  });

  /**
   * THE decision this block exists for. `/` sets a description, `/contact-us`
   * does not — leaving the previous page's description in the head describes
   * the new page with the old page's words to every crawler and share preview
   * that reads it. Absent means REMOVED, for every tag the applier manages.
   */
  it("removes a tag the previous page set and the new page does not", () => {
    const { documentNode, elements } = fakeHead([
      { tagName: "title", textContent: "Home" },
      { tagName: "meta", attributes: { name: "description" }, textContent: "" },
    ]);

    applyDocumentMetadata(documentNode, { title: "Contact us" });

    expect(describeHead(elements)).toEqual(["title Contact us"]);
  });

  it("clears every managed tag when the new page has no metadata at all", () => {
    const { documentNode, elements } = fakeHead([
      { tagName: "meta", attributes: { charset: "utf-8" } },
      { tagName: "title", textContent: "Home" },
      { tagName: "meta", attributes: { name: "description", content: "6 products" } },
      { tagName: "meta", attributes: { property: "og:title", content: "Home" } },
      { tagName: "link", attributes: { rel: "canonical", href: "https://app.test/" } },
    ]);

    applyDocumentMetadata(documentNode, undefined);

    // The charset meta survives: `<Head/>` renders it unconditionally, so it
    // belongs to the document rather than to any page's metadata.
    expect(describeHead(elements)).toEqual(["meta charset=utf-8"]);
  });

  it("updates an existing tag instead of appending a second one", () => {
    const { documentNode, elements } = fakeHead([
      { tagName: "meta", attributes: { name: "description", content: "6 products" } },
    ]);

    applyDocumentMetadata(documentNode, { description: "How to reach us" });

    expect(describeHead(elements)).toEqual(["meta name=description content=How to reach us"]);
  });

  it("joins array keywords the way <Head/> does", () => {
    const { documentNode, elements } = fakeHead([]);

    applyDocumentMetadata(documentNode, { keywords: ["contact", "support"] });

    expect(describeHead(elements)).toEqual(["meta name=keywords content=contact, support"]);
  });

  /**
   * `<Head/>`'s exact rule (`components/head.ts:22-23,43-48`): og:title falls
   * back to the top-level title, but ONLY when `openGraph` is present. The
   * applier mirrors it because the head after a navigation must equal the head
   * after landing on the same URL — two rules would make that comparison a
   * coin toss.
   */
  it("falls og:title back to the title only when openGraph is present", () => {
    const withoutOpenGraph = fakeHead([]);

    applyDocumentMetadata(withoutOpenGraph.documentNode, { title: "Contact us" });

    expect(describeHead(withoutOpenGraph.elements)).toEqual(["title Contact us"]);

    const withOpenGraph = fakeHead([]);

    applyDocumentMetadata(withOpenGraph.documentNode, {
      title: "Contact us",
      openGraph: { image: "https://app.test/og.png" },
    });

    expect(describeHead(withOpenGraph.elements)).toEqual([
      "title Contact us",
      "meta property=og:title content=Contact us",
      "meta property=og:image content=https://app.test/og.png",
    ]);
  });

  it("writes the twitter and canonical tags", () => {
    const { documentNode, elements } = fakeHead([]);

    applyDocumentMetadata(documentNode, {
      canonical: "https://app.test/contact-us",
      robots: "index,follow",
      twitter: { card: "summary", title: "Contact us" },
    });

    // Appended in `<Head/>`'s own order: canonical, then robots, then twitter.
    expect(describeHead(elements)).toEqual([
      "link rel=canonical href=https://app.test/contact-us",
      "meta name=robots content=index,follow",
      "meta name=twitter:card content=summary",
      "meta name=twitter:title content=Contact us",
    ]);
  });
});
