import type { ReactElement } from "react";

/**
 * OPTIONAL placement override for the framework's `<head>` injection — the
 * page's `metadata` output, the stylesheet/preload tags and the
 * canonical/alternate links land here when it is present, and at the default
 * position when it is not (App.tsx:85-92). Takes no props: it says WHERE, and
 * only that.
 */
export function Head(): ReactElement {
  throw new Error("@warlock.js/web is not implemented yet");
}
