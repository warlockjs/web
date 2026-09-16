import { createElement, Fragment, type ReactElement } from "react";
import { stringify } from "devalue";
import { escapePayload, PAYLOAD_SCRIPT_ID, useDocumentContext } from "./document-context";
import { isNonHydrating } from "../server/page-render-bundle";

export type ScriptsProps = {
  /** Per-request CSP nonce for the inline payload script (root.tsx:119). */
  nonce?: string;
};

/**
 * Renders the serialized loader data/`shared` payload, followed by the
 * hydration client entry module — both through React, so streaming SSR can
 * flush them as part of the normal render instead of needing a finished HTML
 * string to splice into. The client module used to be spliced into the
 * rendered HTML string after the fact
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
      // devalue is the page-data wire format (standing ruling): its output is
      // JSON-compatible text (no executable JS — `uneval` is never used here),
      // so this stays a valid `application/json` script even though it now
      // carries Date/Map/Set/BigInt/undefined/cyclic references JSON alone
      // cannot represent.
      type: "application/json",
      nonce: resolvedNonce,
      dangerouslySetInnerHTML: { __html: escapePayload(stringify(payload)) },
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
