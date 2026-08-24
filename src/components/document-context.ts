import { createContext, useContext } from "react";
import type { MetadataOutput } from "../metadata";

export type HydrationDocumentPayloadSource = {
  readonly appData: unknown;
  readonly layoutData: unknown;
  readonly pageData: unknown;
  readonly shared: unknown;
  /**
   * The matched page manifest entry's stable `name` — the same field the
   * manifest entry contract `{ type, name, path, load }` declares. It is on
   * the wire so the browser can look up WHICH page the server rendered
   * instead of re-matching `location.pathname` itself: re-matching is a
   * second implementation of route semantics, and it can disagree with the
   * server on the very request it is hydrating.
   */
  readonly name: string;
};

export const PAYLOAD_SCRIPT_ID = "__WARLOCK_DATA__";

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** Escape JSON text for raw insertion into an application/json script. */
export function escapePayload(json: string): string {
  return json
    .split("<")
    .join("\\u003c")
    .split(">")
    .join("\\u003e")
    .split(LINE_SEPARATOR)
    .join("\\u2028")
    .split(PARAGRAPH_SEPARATOR)
    .join("\\u2029");
}

/**
 * What `<Head/>`/`<Scripts/>` need to render real elements instead of the
 * framework injecting them by string surgery post-render (Suki, room seq
 * 1205): the resolved page metadata and the exact payload the hydration
 * script will read back. Provided once, around the root element, before
 * `renderToString` runs (`render-page.ts`'s stage 9 — the bundle is already
 * complete by then). Universal: no server-only imports, so the client's
 * hydration entry (a later slice) can provide the same shape from the parsed
 * payload script.
 */
export type DocumentContextValue = {
  metadata: MetadataOutput | undefined;
  payload: HydrationDocumentPayloadSource;
  /**
   * The nonce/lang/dir SLOTS: fed by the render provider from CORE request
   * fields — request nonce, request locale — never from app-owned `shared`
   * keys, which an app can overwrite. The provider-side
   * wiring is a separate slice, so these are absent at runtime until it
   * lands; every reader must treat them as optional.
   */
  nonce?: string;
  lang?: string;
  dir?: string;
};

export const DocumentContext = createContext<DocumentContextValue | undefined>(undefined);

/**
 * Require the page pipeline's universal document state. The payload id and
 * escaping helpers remain exported above for the existing server seam.
 */
export function useDocumentContext(componentName: string): DocumentContextValue {
  const value = useContext(DocumentContext);

  if (!value) {
    throw new Error(
      `<${componentName}/> was rendered outside the page pipeline's document context ` +
        "(web/src/components/document-context.ts). Fix: only render it inside " +
        "an App/Layout/Page component tree the pipeline itself renders.",
    );
  }

  return value;
}
