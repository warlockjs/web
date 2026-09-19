import { createElement, Fragment, type ReactElement } from "react";
import {
  resolveMetadataDescriptors,
  type MetadataDescriptor,
} from "../metadata/metadata-descriptors";
import { useDocumentContext } from "./document-context";
import { LOCALE_ROUTING_META_NAME } from "../routing/locale-routing-meta-name";

function renderDescriptor(descriptor: MetadataDescriptor): ReactElement {
  switch (descriptor.kind) {
    case "title":
      return createElement("title", { key: descriptor.key }, descriptor.attrs.value);
    case "meta":
      return createElement("meta", {
        key: descriptor.key,
        [descriptor.attrs.attribute]: descriptor.attrs.name,
        content: descriptor.attrs.content,
      });
    case "link":
      return createElement("link", {
        key: descriptor.key,
        rel: descriptor.attrs.rel,
        href: descriptor.attrs.href,
      });
  }
}

/**
 * OPTIONAL placement override for the framework's `<head>` injection — the
 * page's `metadata` output, the stylesheet/preload tags and the
 * canonical/alternate links land here when it is present, and at the default
 * position when it is not (root.tsx:85-92). Takes no props: it says WHERE, and
 * only that.
 *
 * The metadata tags themselves come from {@link resolveMetadataDescriptors} —
 * the SAME ordered descriptor list `client/navigation/document-metadata.ts`
 * applies after a client-side navigation, so the two agree by construction
 * rather than by two hand-kept lists of fallback rules.
 */
export function Head(): ReactElement {
  const { metadata, stylesheetUrls, localeAlternates, localeRouting } = useDocumentContext("Head");

  return createElement(
    Fragment,
    null,
    createElement("meta", { charSet: "utf-8" }),
    ...resolveMetadataDescriptors(metadata).map(renderDescriptor),
    // Design note §D.2 — framework-owned, not a `MetadataDescriptor`: these
    // are derived from the request/route, never from a page's own
    // `metadata` export (which `resolveMetadataDescriptors` already covers
    // via `canonical`), so they need no slot in that descriptor list.
    ...(localeAlternates ?? []).map((alternate) =>
      createElement("link", {
        key: `alternate-${alternate.hreflang}`,
        rel: "alternate",
        hrefLang: alternate.hreflang,
        href: alternate.href,
      }),
    ),
    // RELEASE BLOCKER fix: carries the SERVER's runtime `LocaleRouting`
    // across the document boundary so the browser stops relying on the
    // build-time `virtual:warlock/pages` guess. `JSON.stringify` produces
    // the `content` attribute VALUE; React (not string concatenation) does
    // the HTML-attribute escaping when it renders this element, so there is
    // no manual escaping here. See `DocumentContextValue.localeRouting` and
    // `entry/publish-document-locale-routing.ts` (the reader).
    ...(localeRouting
      ? [
          createElement("meta", {
            key: "locale-routing",
            name: LOCALE_ROUTING_META_NAME,
            content: JSON.stringify(localeRouting),
          }),
        ]
      : []),
    // Rendered last, mirroring where the framework's old post-render splice
    // inserted them (right before `</head>`, after everything else the
    // document already put there) — see `stylesheetUrls` on
    // `DocumentContextValue`.
    ...(stylesheetUrls ?? []).map((url) =>
      createElement("link", { key: url, rel: "stylesheet", href: url }),
    ),
  );
}
