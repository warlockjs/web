import type { Keywords } from "@mongez/localization";
import { createContext, useContext } from "react";
import type { MetadataOutput } from "../metadata";
import type { LocaleRouting } from "../routing/locale-routing";

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
  /**
   * Production-only opaque correlation id joining this browser-visible error
   * to its full detail in the server's own error report line. Never present
   * alongside `stack`; see `serializePageError` (`web/src/server/error-page.ts`).
   */
  readonly errorCode?: string;
  /**
   * Present only for a `PageValidationFailedError` (a failed page-level
   * `validation` export). Each entry is the Seal validation result's
   * `{ input, type, error }` — the field name, the failing rule's type, and
   * its (translated) message — and NOTHING else: never the submitted value.
   * See `serializePageError` (`web/src/server/error-page.ts`).
   */
  readonly errors?: readonly {
    readonly input: string;
    readonly type: string;
    readonly error: string;
  }[];
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
  /** The request locale selected by core for this exact render. */
  readonly locale: string;
  /**
   * The ACTIVE locale's keyword table only — never every locale core has
   * globbed from `utils/locales.ts`.
   *
   * The server's `@mongez/localization` table is filled eagerly at boot for
   * every registered locale, but nothing ever filled the browser's copy of
   * that same process-global table, so `useTrans()` (`../localization.tsx`)
   * silently returned the raw key after hydration even though the server
   * markup was correct. Shipping the WHOLE table would work too, but every
   * locale's strings would cross the wire on every request regardless of
   * which one the visitor is using; shipping only {@link locale}'s entries
   * keeps the wire payload proportional to one language instead of every
   * language the app supports. Per-page or per-group scoping is a later
   * card, not this one.
   */
  readonly translations: Keywords;
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
   * mounts at `#vessel`, which App contains). So on a client navigation there is
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
  /**
   * Top-level `pageData` key names, in declaration order, that a `defer()`
   * call produced (Stage 2 implementation contract, rule 3) — a page
   * component reads each with `use()` and must NOT be handed a bare value.
   * Omitted — not `[]` — when nothing is deferred, so the hard-navigate
   * completeness check keeps seeing the same six required keys either way.
   *
   * Two wire shapes share this one marker, and the client tells them apart by
   * whether the key is still present on `pageData`:
   *
   *   - STREAMED (the document, and NDJSON navigations): the key is REMOVED
   *     from `pageData` — its value is a live Promise, not JSON-safe — and
   *     settles later through a `__WARLOCK_DEFER__` chunk/line
   *     (`defer-registry.ts`'s `prepareDeferredPageData`).
   *   - INLINED (a `serverCache` route's JSON representation, which never
   *     streams — see `build-hydration-payload.ts`'s `inlinedDeferredKeys`):
   *     the key STAYS on `pageData`, already resolved. The client wraps it in
   *     an already-fulfilled thenable (`fetch-page-data.ts`'s
   *     `reviveInlinedDeferredValues`) so `use()` reads it synchronously —
   *     RELEASE BLOCKER fix, a bare resolved value used to reach `use()`
   *     unwrapped ("Minified React error #438").
   */
  readonly deferred?: readonly string[];
};

export const PAYLOAD_SCRIPT_ID = "__WARLOCK_DATA__";

/**
 * The hydration MOUNT point id — a different id from {@link PAYLOAD_SCRIPT_ID}.
 * `id="root"` used to collide with common embeds and third-party widgets that
 * also reach for `#root` (analytics snippets, payment SDKs, dev extensions),
 * so the framework's own mount point is namespaced instead. Single source of
 * truth for both the App shell (`components/default-app.tsx`) that renders
 * `<div id={HYDRATION_ROOT_ID}>` and the client entry
 * (`client/hydrate-page.tsx`) that resolves it via `getElementById` — apps and
 * docs that cannot import this constant use the literal `vessel` instead.
 */
export const HYDRATION_ROOT_ID = "vessel";

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
  /**
   * This page's resolved stylesheet URLs, in cascade order (root, then
   * outer-to-inner layouts, then the page). Rendered by `<Head/>` as
   * render-blocking `<link rel="stylesheet">` tags — streaming SSR renders
   * the document through React instead of splicing strings into it after the
   * fact (`create-page-route-handler.ts`'s old `installStylesheets`), so it
   * now has to travel through this context like every other document slot.
   * Absent or empty means no stylesheets for this page, never a failed
   * resolution.
   */
  stylesheetUrls?: readonly string[];
  /**
   * The browser module appended after the server-rendered document, rendered
   * by `<Scripts/>` as a `<script type="module">` carrying the same `nonce`
   * as the hydration payload script. Same Stage 1 move as
   * {@link stylesheetUrls} — this used to be a post-render splice
   * (`installHydrationClientModule`); it is now real React output, gated by
   * the same non-hydrating check the payload script already uses (a
   * `renderPageFailure` document, which has no trustworthy triple to
   * hydrate against, never gets one — regardless of whether this URL is
   * present).
   */
  hydrationClientModuleUrl?: string;
  /**
   * `modulepreload` URLs for the hydration entry's own STATICALLY imported
   * chunks (card 53f8647e) — the `vendor-react` chunk
   * `../vite/build-client.ts`'s `warlockHydrationManualChunks` splits
   * React/ReactDOM/scheduler into, most of all. Rendered by `<Head/>` as
   * `<link rel="modulepreload">` tags, ALONGSIDE {@link hydrationClientModuleUrl}'s
   * own `<script type="module">`, so the browser fetches the vendor chunk in
   * parallel with the entry instead of discovering it only after parsing the
   * entry's own `import` statement — one extra sequential round trip the
   * split must not cost. Absent or empty means the entry has no static
   * imports worth preloading (dev, or a manifest with none), never a failed
   * resolution — see `resolveHydrationClientModulePreloadUrls`
   * (`../server/hydration-client-url.ts`), which never throws.
   */
  hydrationClientModulePreloadUrls?: readonly string[];
  /**
   * The `<link rel="alternate" hreflang>` set for THIS request — design note
   * §D.2, built by `server/resolve-locale-alternates.ts` and rendered
   * verbatim by `<Head/>`. `undefined` for a page that is not locale-routed
   * at all (strategy `"none"` and not a `:locale` route), and also when the
   * page's own `metadata.canonical` is set — an author who already declared
   * their own canonical owns their own alternates too, so the framework
   * never adds a second, possibly-conflicting set (design note §D.2, "A
   * page's own metadata alternates/canonical, if any exists, wins; don't
   * duplicate").
   */
  localeAlternates?: readonly { readonly hreflang: string; readonly href: string }[];
  /**
   * The runtime locale-routing table for THIS request — released blocker fix:
   * a PRODUCTION browser build resolves `web.localeRouting` at BUILD time
   * (`vite/page-registry-plugin.ts` + `build/generate-locale-routing.ts`,
   * exported as `virtual:warlock/pages`'s `localeRouting`), which is wrong
   * whenever the app config wasn't loaded at build time or differs per
   * environment — the browser then hydrates with `{ strategy: "none" }` even
   * though the server is actively locale-routing, and `<Link>`
   * prefixing/`changeLocaleCode` go dead in prod.
   *
   * The fix: the SERVER document carries the table it actually resolved.
   * `<Head/>` (`components/head.ts`) renders it as a
   * `<meta name="warlock-locale-routing">` tag; the hydration entry
   * (`entry/publish-document-locale-routing.ts`) reads that meta BEFORE
   * mount and publishes it, falling back to the build-time
   * `virtual:warlock/pages` value only when the meta is absent or malformed.
   * Set by `resolveDocumentLocaleRouting()` (`server/resolve-locale-alternates.ts`)
   * from `readLocaleRouting()` — the SAME published table `localeAlternates`
   * above is built from — under the identical strategy-none/`:locale`-route
   * gate, so `undefined` here means the page is not locale-routed at all.
   */
  localeRouting?: LocaleRouting;
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
