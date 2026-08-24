import { createElement, Fragment, type ReactElement } from "react";
import { useDocumentContext } from "./document-context";

/**
 * OPTIONAL placement override for the framework's `<head>` injection — the
 * page's `metadata` output, the stylesheet/preload tags and the
 * canonical/alternate links land here when it is present, and at the default
 * position when it is not (root.tsx:85-92). Takes no props: it says WHERE, and
 * only that.
 */
export function Head(): ReactElement {
  const { metadata } = useDocumentContext("Head");

  const keywords =
    metadata?.keywords === undefined
      ? undefined
      : Array.isArray(metadata.keywords)
        ? metadata.keywords.join(", ")
        : metadata.keywords;

  const openGraph = metadata?.openGraph;
  // Falls back to the top-level fields — the only two fallbacks the type declares.
  const ogTitle = openGraph?.title ?? metadata?.title;
  const ogDescription = openGraph?.description ?? metadata?.description;

  const twitter = metadata?.twitter;

  return createElement(
    Fragment,
    null,
    createElement("meta", { charSet: "utf-8" }),
    metadata?.title !== undefined ? createElement("title", null, metadata.title) : null,
    metadata?.description !== undefined
      ? createElement("meta", { name: "description", content: metadata.description })
      : null,
    keywords !== undefined ? createElement("meta", { name: "keywords", content: keywords }) : null,
    metadata?.canonical !== undefined
      ? createElement("link", { rel: "canonical", href: metadata.canonical })
      : null,
    metadata?.robots !== undefined
      ? createElement("meta", { name: "robots", content: metadata.robots })
      : null,
    openGraph !== undefined && ogTitle !== undefined
      ? createElement("meta", { property: "og:title", content: ogTitle })
      : null,
    openGraph !== undefined && ogDescription !== undefined
      ? createElement("meta", { property: "og:description", content: ogDescription })
      : null,
    openGraph?.image !== undefined
      ? createElement("meta", { property: "og:image", content: openGraph.image })
      : null,
    openGraph?.url !== undefined
      ? createElement("meta", { property: "og:url", content: openGraph.url })
      : null,
    openGraph?.type !== undefined
      ? createElement("meta", { property: "og:type", content: openGraph.type })
      : null,
    twitter?.card !== undefined
      ? createElement("meta", { name: "twitter:card", content: twitter.card })
      : null,
    twitter?.title !== undefined
      ? createElement("meta", { name: "twitter:title", content: twitter.title })
      : null,
    twitter?.description !== undefined
      ? createElement("meta", { name: "twitter:description", content: twitter.description })
      : null,
    twitter?.image !== undefined
      ? createElement("meta", { name: "twitter:image", content: twitter.image })
      : null,
  );
}
