import { createElement, type ReactElement } from "react";
import { escapePayload, PAYLOAD_SCRIPT_ID, useDocumentContext } from "./document-context";

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
