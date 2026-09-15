import { createElement, Fragment, type ReactElement } from "react";
import { escapePayload, PAYLOAD_SCRIPT_ID, useDocumentContext } from "./document-context";
import { isNonHydrating } from "../server/page-render-bundle";

export type ScriptsProps = {
  /** Per-request CSP nonce for the inline payload script (root.tsx:119). */
  nonce?: string;
};

/**
 * Renders the serialized loader data/`shared` payload, followed by the
 * hydration client entry module — both through React (Stage 1 streaming SSR,
 * `releases/v5.12-streaming-design.md`). The client module used to be spliced
 * into the rendered HTML string after the fact
 * (`create-page-route-handler.ts`'s old `installHydrationClientModule`); it
 * is now real output from this component, in the same document-context slot
 * the payload script already reads, so both carry the request's CSP nonce
 * and both disappear together on a non-hydrating document.
 */
export function Scripts(props: ScriptsProps): ReactElement {
  const { payload, nonce, hydrationClientModuleUrl } = useDocumentContext("Scripts");

  // `renderPageFailure` marks its payload non-hydrating (page-render-bundle.ts):
  // a module-load/registration throw happens before any triple exists, so
  // there is nothing trustworthy for a hydration script to describe or a
  // client module to attach to. A normal app `error.page.tsx` payload (from
  // `finishRender`) is never marked and keeps emitting both below.
  if (isNonHydrating(payload)) return createElement(Fragment, null);

  // Explicit prop wins: v5/app's root.tsx passes `shared.nonce` today
  // (root.tsx:119) and must keep working unchanged. Only an absent prop falls
  // back to the framework's nonce slot (document-context.ts).
  const resolvedNonce = props.nonce ?? nonce;

  return createElement(
    Fragment,
    null,
    // `dangerouslySetInnerHTML`, not children: the serializer's escaped output
    // must reach the document byte-for-byte. React's default child-text
    // escaping (HTML-entity escaping) would double-process it and corrupt the
    // JSON (spike P7's escaping contract).
    createElement("script", {
      id: PAYLOAD_SCRIPT_ID,
      type: "application/json",
      nonce: resolvedNonce,
      dangerouslySetInnerHTML: { __html: escapePayload(JSON.stringify(payload)) },
    }),
    hydrationClientModuleUrl !== undefined
      ? createElement("script", {
          type: "module",
          nonce: resolvedNonce,
          src: hydrationClientModuleUrl,
        })
      : null,
  );
}
