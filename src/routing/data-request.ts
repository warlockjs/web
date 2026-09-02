/**
 * The marker that turns a page request into a DATA request.
 *
 * A client navigation needs exactly what a full page load needs — middleware,
 * validation, loaders, redirects, cookies, the settled status — and differs in
 * one respect only: it wants the hydration payload as JSON instead of a
 * rendered document. So it is deliberately NOT a separate `/_loader` route.
 *
 * WHY NOT A SEPARATE ROUTE. A `/_loader?path=/products/42` endpoint has to
 * resolve that path to a page itself, which is a SECOND implementation of route
 * semantics living beside the server's. This codebase already refuses that
 * bargain for the browser — the hydration payload carries the route `name` so
 * the client never re-matches — and the same reasoning applies here with more
 * force: a loader endpoint that disagreed with the real route about params,
 * prefixes or which page owns a path would answer a different request than the
 * one the user navigated to. Same URL, same route, same matcher, same pipeline;
 * only the final representation differs.
 *
 * WHY A HEADER AND NOT `?_data=1`. The query string belongs to the page — it is
 * what `validation` and loaders read. Injecting a framework key into it means a
 * page with strict query validation rejects its own client navigations, and
 * every loader that echoes its query starts leaking a private flag.
 *
 * Responses to a data request must carry `Vary: <this header>` so a shared
 * cache can never hand a document to a client that asked for JSON, or the
 * reverse. Most page responses are `no-store` — which makes that theoretical
 * — but an opted-in route (`route.cache`, `../routing/route-identity.ts`) is
 * genuinely `public, max-age=<n>` on BOTH representations
 * (`response-cache-floor.ts`), so `Vary` is what keeps a shared cache from
 * ever conflating them.
 */
export const WARLOCK_DATA_REQUEST_HEADER = "x-warlock-data";

/**
 * The value the client sends. Any non-empty value is honoured on the way in —
 * the header's PRESENCE is the signal — but the client sends this one so the
 * traffic is self-describing in a log or a network panel.
 */
export const WARLOCK_DATA_REQUEST_VALUE = "1";

/**
 * Declared explicitly because the payload goes on the wire ALREADY SERIALIZED,
 * as a string, and core only auto-picks `application/json` for object bodies.
 * See the send site for why it must be a string.
 */
export const DATA_RESPONSE_CONTENT_TYPE = "application/json";

/**
 * Whether a request asked for the payload rather than the document.
 *
 * Presence-based on purpose: a proxy that rewrites the value, or a client on a
 * newer version that sends something more specific, still means "data". Only an
 * absent or empty header means "render the document".
 */
export function isDataRequest(headerValue: string | string[] | undefined): boolean {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  return typeof value === "string" && value.length > 0;
}
