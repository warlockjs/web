import { createElement, Fragment, type ReactElement } from "react";
import { escapePayload, PAYLOAD_SCRIPT_ID, useDocumentContext } from "./document-context";
import { isNonHydrating } from "../server/page-render-bundle";

export type ScriptsProps = {
  /** Per-request CSP nonce for the inline payload script (root.tsx:119). */
  nonce?: string;
};

/**
 * OPTIONAL placement override for the serialized loader data and `shared`.
 * Hydration module emission is separate wiring.
 */
export function Scripts(props: ScriptsProps): ReactElement {
  const { payload, nonce } = useDocumentContext("Scripts");

  // `renderPageFailure` marks its payload non-hydrating (page-render-bundle.ts):
  // a module-load/registration throw happens before any triple exists, so
  // there is nothing trustworthy for a hydration script to describe. A normal
  // app `error.page.tsx` payload (from `finishRender`) is never marked and
  // keeps emitting `__WARLOCK_DATA__` below.
  if (isNonHydrating(payload)) return createElement(Fragment, null);

  // Explicit prop wins: v5/app's root.tsx passes `shared.nonce` today
  // (root.tsx:119) and must keep working unchanged. Only an absent prop falls
  // back to the framework's nonce slot (document-context.ts).
  const resolvedNonce = props.nonce ?? nonce;

  // `dangerouslySetInnerHTML`, not children: the serializer's escaped output must
  // reach the document byte-for-byte. React's default child-text escaping
  // (HTML-entity escaping) would double-process it and corrupt the JSON
  // (spike P7's escaping contract).
  return createElement("script", {
    id: PAYLOAD_SCRIPT_ID,
    type: "application/json",
    nonce: resolvedNonce,
    dangerouslySetInnerHTML: { __html: escapePayload(JSON.stringify(payload)) },
  });
}
