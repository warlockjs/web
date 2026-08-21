import { createContext, useContext } from "react";
import type { MetadataOutput } from "../metadata";

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
  payload: {
    appData: unknown;
    layoutData: unknown;
    pageData: unknown;
    shared: unknown;
  };
};

export const DocumentContext = createContext<DocumentContextValue | undefined>(undefined);

/**
 * Id the hydration slice reads the payload back out by. Owned here, not in
 * `render-page.ts`, because `<Scripts/>` (this module's consumer) renders on
 * BOTH server and client (App.tsx's own doc comment) — a component that ships
 * to the browser cannot import from `web/src/server/*` without tripping
 * Gate A's client/server boundary. `render-page.ts` imports this constant
 * from here instead of defining it.
 */
export const PAYLOAD_SCRIPT_ID = "__WARLOCK_DATA__";

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * The payload-script escape (canon 20c425dd §3 stage 10). Escaping EVERY `<`
 * and `>` as unicode sequences is strictly wider than the named sequences
 * (`</script` and `<!--` both contain `<`; `-->` contains `>`) and is safe:
 * in JSON text those characters can only occur inside string literals, where
 * the \uXXXX form is the same string. U+2028/U+2029 are legal raw in JSON
 * strings but terminate lines in JavaScript — escaped for the same
 * inline-script safety.
 */
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
