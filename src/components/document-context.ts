import { createContext, useContext } from "react";
import type { MetadataOutput } from "../metadata";

/**
 * The JSON-safe error shape carried from the server document to browser
 * hydration.
 *
 * This is deliberately NOT the original thrown object. Error prototypes,
 * identity, non-enumerable fields and arbitrary custom values do not survive a
 * JSON boundary reliably. The server renders `ErrorPageProps` with the
 * original value, then normalizes it to this lossy representation only for the
 * hydration payload. Normalization also owns disclosure: `stack` is optional
 * and must be omitted or redacted when server internals are not safe to expose
 * to the browser.
 */
export type SerializedPageError = {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
};

/**
 * Props received by the application-owned `error.page.tsx` during SSR.
 *
 * Deliberately preserve the thrown value here. An application can use its own
 * error classes, symbols, or structured values while rendering on the server;
 * this public component contract is not a JSON boundary.
 */
export type ErrorPageProps = {
  readonly error: unknown;
  readonly status: number;
};

/**
 * The JSON-safe counterpart of {@link ErrorPageProps}, used only after the
 * document crosses from SSR into browser hydration. Keeping this distinct
 * prevents a serialized approximation from being mistaken for the original
 * thrown value available to the server render.
 */
export type SerializedErrorPageProps = {
  readonly error: SerializedPageError;
  readonly status: number;
};

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
  /**
   * The params the SERVER matched for this request — `bundle.route.params`
   * (`server/execute-page-request.ts:288`), carried untransformed. Same reason
   * `name` is here: the browser must not re-derive them from
   * `location.pathname`, because deriving them IS a second matcher.
   *
   * OPTIONAL, and ungated on purpose — see {@link metadata} below for the rule
   * both new keys share. The server always emits it (`{}` for a route with no
   * dynamic segments), so absence means the payload came from a producer that
   * predates this key; `currentRoute()` then reports `{}` rather than failing a
   * page over an accessor.
   */
  readonly params?: Readonly<Record<string, string>>;
  /**
   * The page metadata the server resolved at stage 8, carried WHOLE — the same
   * `MetadataOutput` `<Head/>` rendered into the document on the first request.
   *
   * Why it has to be on the wire at all: `<Head/>` renders inside the App
   * level, and the App level is not part of the hydrated tree (the client
   * mounts at `#root`, which App contains). So on a client navigation there is
   * no React render that can reach `<head>` — without this key the browser
   * never learns the new page's title and the tab keeps the old one.
   *
   * OPTIONAL, deliberately: `bundle.metadata` is itself optional
   * (`server/execute-page-request.ts:296`) — a page that exports no `metadata`
   * produces none, and a loader short-circuit skips stage 8 entirely. Gating a
   * key the server is right not to produce would make `readHydrationPayload`
   * throw on a valid page. Present-but-not-an-object is still MALFORMED and
   * still throws; only ABSENT is accepted.
   */
  readonly metadata?: MetadataOutput;
  /**
   * Present only when the server selected the application-owned error page for
   * this response. Atomic rather than two independently optional top-level
   * fields: a status without an error (or the reverse) cannot describe a tree
   * the browser can hydrate.
   *
   * `name` above intentionally remains the ORIGINAL matched route. This field
   * selects the `ErrorPage` module projected into that route's client
   * composition; it does not turn the error page into a second browsable route.
   */
  readonly errorPage?: SerializedErrorPageProps;
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
