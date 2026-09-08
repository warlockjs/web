import type { MetadataOutput } from "../../metadata";

/**
 * ONE tag `<head>` may hold at most one of, addressed the way the browser
 * already addresses it. No marker attribute: the tags this replaces were
 * rendered by `<Head/>` on the server and carry none, and a marker would make
 * the applier ignore exactly the tags it exists to correct — the first
 * navigation's.
 */
type ManagedTag = {
  /** Finds the existing tag, server-rendered or applied by a previous swap. */
  selector: string;
  create: (documentNode: Document) => Element;
  write: (element: Element, value: string) => void;
};

function metaTag(attribute: "name" | "property", key: string): ManagedTag {
  return {
    selector: `meta[${attribute}="${key}"]`,
    create: (documentNode) => {
      const element = documentNode.createElement("meta");

      element.setAttribute(attribute, key);

      return element;
    },
    write: (element, value) => element.setAttribute("content", value),
  };
}

const TITLE_TAG: ManagedTag = {
  selector: "title",
  create: (documentNode) => documentNode.createElement("title"),
  write: (element, value) => {
    element.textContent = value;
  },
};

const CANONICAL_TAG: ManagedTag = {
  selector: 'link[rel="canonical"]',
  create: (documentNode) => {
    const element = documentNode.createElement("link");

    element.setAttribute("rel", "canonical");

    return element;
  },
  write: (element, value) => element.setAttribute("href", value),
};

/**
 * The metadata, resolved into (tag, value) pairs in `<Head/>`'s ORDER and by
 * `<Head/>`'s RULES — including the og fallbacks and the fact that they apply
 * only when `openGraph` is present (`components/head.ts:21-24,43-48`).
 *
 * The duplication is deliberate and it is the known cost here. `<Head/>` is a
 * React component that renders elements into a tree; this writes elements into
 * a live `<head>` that no client tree owns. They cannot be one function today,
 * but they MUST agree: the head after navigating to a URL has to equal the head
 * after landing on it, or a share preview depends on how the visitor arrived.
 * The fix is a shared descriptor list both consume — see the report's followup.
 */
function resolveManagedTags(
  metadata: MetadataOutput | undefined,
): readonly (readonly [ManagedTag, string | undefined])[] {
  const keywords =
    metadata?.keywords === undefined
      ? undefined
      : Array.isArray(metadata.keywords)
        ? metadata.keywords.join(", ")
        : (metadata.keywords as string);

  const openGraph = metadata?.openGraph;
  const twitter = metadata?.twitter;

  return [
    [TITLE_TAG, metadata?.title],
    [metaTag("name", "description"), metadata?.description],
    [metaTag("name", "keywords"), keywords],
    [CANONICAL_TAG, metadata?.canonical],
    [metaTag("name", "robots"), metadata?.robots],
    [metaTag("property", "og:title"), openGraph && (openGraph.title ?? metadata?.title)],
    [
      metaTag("property", "og:description"),
      openGraph && (openGraph.description ?? metadata?.description),
    ],
    [metaTag("property", "og:image"), openGraph?.image],
    [metaTag("property", "og:url"), openGraph?.url],
    [metaTag("property", "og:type"), openGraph?.type],
    [metaTag("name", "twitter:card"), twitter?.card],
    [metaTag("name", "twitter:title"), twitter?.title],
    [metaTag("name", "twitter:description"), twitter?.description],
    [metaTag("name", "twitter:image"), twitter?.image],
  ];
}

/**
 * Make `<head>` describe the page now on screen.
 *
 * ## Why this is imperative, and why that is not a shortcut
 *
 * `<Head/>` renders inside the App level, and the App level is deliberately NOT
 * in the hydrated tree — the client mounts at `#root`, which App contains
 * (`client/build-hydrated-tree.ts`'s header). So no client render can reach
 * `<head>`, and a swap either writes it directly or leaves the previous page's
 * title in the tab. It leaves it today; that is the bug.
 *
 * ## ABSENT MEANS REMOVED
 *
 * Every managed tag the new metadata does not set is REMOVED, not left alone.
 * `/` sets a description and `/contact-us` does not: keeping it would describe
 * the contact page with the home page's words to every crawler, share preview
 * and assistive reader that looks — a wrong answer, where an absent one is
 * merely absent. A title the new page does not set goes too, and the tab falls
 * back to the URL, which is the honest rendering of "this page did not name
 * itself".
 *
 * Only the tags `<Head/>` renders FROM METADATA are touched. The charset meta
 * is rendered unconditionally and belongs to the document, so it is left alone.
 *
 * Takes the document as an argument rather than reaching for the global, which
 * is what makes it provable in a suite with no DOM.
 */
export function applyDocumentMetadata(
  documentNode: Document,
  metadata: MetadataOutput | undefined,
): void {
  for (const [tag, value] of resolveManagedTags(metadata)) {
    const existing = documentNode.querySelector(tag.selector);

    if (value === undefined) {
      existing?.remove();
      continue;
    }

    if (existing !== null) {
      tag.write(existing, value);
      continue;
    }

    const created = tag.create(documentNode);

    tag.write(created, value);
    documentNode.head.appendChild(created);
  }
}
