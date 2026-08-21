import { createElement, type ReactElement } from "react";
import { escapePayload, PAYLOAD_SCRIPT_ID, useDocumentContext } from "./document-context";

export type ScriptsProps = {
  /** Per-request CSP nonce for the inline payload script (App.tsx:119). */
  nonce?: string;
};

/**
 * OPTIONAL placement override for the serialized payload (every loader's data
 * + `shared`, escaped) and the hydration modules. Written when placement
 * genuinely matters — a CSP nonce, or ordering against the app's own scripts.
 */
export function Scripts(props: ScriptsProps): ReactElement {
  const { payload } = useDocumentContext("Scripts");

  // `dangerouslySetInnerHTML`, not children: `escapePayload`'s output must
  // reach the document byte-for-byte. React's default child-text escaping
  // (HTML-entity escaping) would double-process it and corrupt the JSON
  // (spike P7's escaping contract — see document-context.ts's own comment).
  return createElement("script", {
    id: PAYLOAD_SCRIPT_ID,
    type: "application/json",
    nonce: props.nonce,
    dangerouslySetInnerHTML: { __html: escapePayload(JSON.stringify(payload)) },
  });
}
