import type { MetadataOutput } from "../../metadata";
import {
  MANAGED_METADATA_KEYS,
  resolveMetadataDescriptors,
  type MetadataDescriptor,
} from "../../metadata/metadata-descriptors";

function createElementFor(documentNode: Document, key: string): Element {
  if (key === "title") return documentNode.createElement("title");
  if (key.startsWith("meta[")) return documentNode.createElement("meta");

  return documentNode.createElement("link");
}

function writeDescriptor(element: Element, descriptor: MetadataDescriptor): void {
  switch (descriptor.kind) {
    case "title":
      element.textContent = descriptor.attrs.value;
      return;
    case "meta":
      element.setAttribute(descriptor.attrs.attribute, descriptor.attrs.name);
      element.setAttribute("content", descriptor.attrs.content);
      return;
    case "link":
      element.setAttribute("rel", descriptor.attrs.rel);
      element.setAttribute("href", descriptor.attrs.href);
      return;
  }
}

/**
 * Make `<head>` describe the page now on screen.
 *
 * ## Why this is imperative, and why that is not a shortcut
 *
 * `<Head/>` renders inside the App level, and the App level is deliberately NOT
 * in the hydrated tree — the client mounts at `#vessel`, which App contains
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
 *
 * The (tag, value) pairs and their fallback rules come from
 * {@link resolveMetadataDescriptors} — the SAME function `<Head/>` renders
 * from, so the head after navigating to a URL equals the head after landing
 * on it by construction.
 */
export function applyDocumentMetadata(
  documentNode: Document,
  metadata: MetadataOutput | undefined,
): void {
  const descriptorsByKey = new Map(
    resolveMetadataDescriptors(metadata).map((descriptor) => [descriptor.key, descriptor]),
  );

  for (const key of MANAGED_METADATA_KEYS) {
    const existing = documentNode.querySelector(key);
    const descriptor = descriptorsByKey.get(key);

    if (descriptor === undefined) {
      existing?.remove();
      continue;
    }

    const element = existing ?? createElementFor(documentNode, key);

    writeDescriptor(element, descriptor);

    if (existing === null) documentNode.head.appendChild(element);
  }
}
