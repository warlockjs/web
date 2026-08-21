import { createElement, Fragment, type ReactElement } from "react";
import { useDocumentContext } from "./document-context";

/**
 * OPTIONAL placement override for the framework's `<head>` injection — the
 * page's `metadata` output, the stylesheet/preload tags and the
 * canonical/alternate links land here when it is present, and at the default
 * position when it is not (App.tsx:85-92). Takes no props: it says WHERE, and
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
  );
}
