import type { HydrationDocumentPayloadSource } from "../../hydration-payload";

/**
 * "Which route am I on?", under the name MRR spells it
 * (`@mongez/react-router` — `src/utilities.tsx`).
 *
 * ## The shift, and it is the whole point of this file
 *
 * MRR's `currentRoute()` returns the object ITS MATCHER produced: MRR is a CSR
 * router, so the browser matched the URL and the answer is the browser's own
 * conclusion. Warlock has no client matcher and must never grow one (canon
 * `9c8f878b`) — the SERVER router is the only matcher, and a second one can
 * disagree with it about the very request it is hydrating.
 *
 * So the name is MRR's because the QUESTION is the same one, but the ANSWER
 * comes from somewhere else: the matched entry's name AND ITS PARAMS travel on
 * the hydration payload (`web/src/components/document-context.ts`), and this
 * module reports what arrived. Nothing here parses a path, compares a URL to a
 * pattern, or knows that routes have shapes.
 *
 * The practical consequence for a caller: this is the server's match, so it is
 * as correct as the page on screen and it cannot drift from it — including on
 * the very first render, before any client navigation, which is most page
 * views.
 *
 * ## The params, and where they come from
 *
 * `bundle.route.params` (`web/src/server/execute-page-request.ts:288`) is the
 * router's own answer; `buildHydrationPayload` puts it on the payload and the
 * projection below hands it over unchanged. Deriving `{ id: "42" }` from
 * `location.pathname` here would BE the second matcher this file exists to
 * refuse — a URL and a pattern are exactly what it must never compare.
 *
 * ## Why nothing here touches `window`
 *
 * Both readers are importable from universal modules, so both can be CALLED
 * during the server render and in the gap between first paint and hydration.
 * They read module state and nothing else, so there is no browser to be missing
 * — the answer in those contexts is `undefined`, meaning "no page has been
 * rendered into this module", which is exactly true.
 */

/**
 * What the SERVER matched for the page currently on screen.
 *
 * Deliberately not `ClientRouteMatch` (`web/src/client/runtime/types.ts`): that
 * is the deprecated client matcher's output shape, entry object and all, and
 * this is the opposite claim — a name the server sent us.
 */
export type MatchedRoute = {
  /** The matched page manifest entry's stable `name`, e.g. `products.details`. */
  readonly name: string;
  /**
   * The params the SERVER matched, e.g. `{ id: "42" }` for `/users/:id`, and
   * `{}` for a route with no dynamic segments.
   *
   * `undefined` means the payload carried no `params` key — an older build, or
   * a document cached across a deploy. It is NOT the same answer as `{}`, and
   * this module will not collapse the two: `{}` is the server saying "this
   * route has no params", `undefined` is the server not having said. Inventing
   * the first from the second would be a lie a caller cannot detect, which is
   * the same standard {@link previousRoute} is held to below. Every payload a
   * current server produces carries the key.
   *
   * A COPY of the payload's object, so a caller writing to it cannot reach the
   * payload the page was built from.
   */
  readonly params?: Readonly<Record<string, string>>;
};

let current: MatchedRoute | undefined;
let previous: MatchedRoute | undefined;

/**
 * The payload `current` was projected from, kept ONLY to recognise it again.
 *
 * `NavigationRoot` records on every render pass, because a page component must
 * be able to call `currentRoute()` while it is itself rendering — including on
 * the initial mount, where no effect has run yet. Renders are not navigations
 * though: StrictMode invokes them twice, and a parent re-render invokes them
 * again for free. One swap is one payload OBJECT, so identity is what separates
 * "we moved" from "we rendered again". Comparing names instead would both miss
 * a `/users/1` → `/users/2` move and invent one out of a double render.
 */
let source: HydrationDocumentPayloadSource | undefined;

/**
 * Record the payload the page on screen was built from.
 *
 * Called by `NavigationRoot` during render — at mount with the hydration
 * payload, and after each swap with the fetched one. Not part of the public
 * surface: the payload is the navigation runtime's to hand over, and a caller
 * setting the current route by hand would be asserting a match that never
 * happened.
 *
 * Idempotent per payload object, so re-rendering the same page never shifts
 * {@link previousRoute}.
 */
export function recordCurrentRoute(payload: HydrationDocumentPayloadSource): void {
  if (source === payload) return;

  source = payload;
  previous = current;
  // A COPY when the payload carried params, and no key at all when it did not
  // — the projection reports what arrived and never fills a gap in.
  current =
    payload.params === undefined
      ? { name: payload.name }
      : { name: payload.name, params: { ...payload.params } };
}

/**
 * @returns what the SERVER matched for the page on screen — see this file's
 * header for why that is the answer and not a client-side match. Correct from
 * the first render of the initial page, since the hydration payload carried the
 * match with it.
 *
 * `undefined` means no page has been rendered into this module: a server
 * render, or an import evaluated before hydration mounted. Safe to call in
 * either — it does not throw and does not touch `window`.
 */
export function currentRoute(): MatchedRoute | undefined {
  return current;
}

/**
 * @returns the entry that was on screen BEFORE the current one, or `undefined`
 * when the current page is the one the user landed on. That `undefined` is a
 * real answer, not a missing one — there is no previous route on a first visit,
 * and reporting the current one would be a lie a caller cannot detect.
 *
 * This is the previously SWAPPED page, not the previous history entry: pressing
 * Back is itself a navigation here, so going A → B → Back leaves the previous
 * route as B. Safe to call with no browser.
 */
export function previousRoute(): MatchedRoute | undefined {
  return previous;
}
