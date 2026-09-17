/**
 * The ONE place the hydration payload's shape is decided.
 *
 * Two callers need the identical object and must never drift:
 *
 *   `render-page.ts`   embeds it in the document as `#__WARLOCK_DATA__`, which
 *                      is what a FULL page load hands the browser.
 *   the `_loader` route returns it as JSON, which is what a CLIENT navigation
 *                      fetches instead of re-rendering the document.
 *
 * Drift between those two is not a cosmetic bug: the browser builds the same
 * React tree from either source, so a key present on one path and absent on the
 * other produces a page that works when you land on it and breaks when you
 * navigate to it — or the reverse, which is worse, because the first visit is
 * the one everybody tests.
 *
 * Extracted rather than duplicated for exactly that reason. It was previously
 * assembled inline inside the renderer, where the loader route could not reach
 * it without copying five lines that would then be free to diverge.
 */
import { getKeywordsListOf } from "@mongez/localization";
import type { HydrationDocumentPayloadSource } from "../components/document-context";
import type { PageDataBundle } from "./execute-page-request";
import { assertPageDataSerializable } from "./page-data-serialization-error";

/**
 * Levels without a loader resolve to `undefined`, but the hydration contract
 * requires every data key to be PRESENT.
 *
 * An intentional `null` is preserved — a loader that returned `null` said
 * something, and flattening it would erase that. Only "no data at all" becomes
 * an empty object.
 */
function serializableData(data: unknown): unknown {
  return data === undefined ? {} : data;
}

/**
 * The WIRE view of `pageData` for a page that called `defer()` (Stage 2
 * implementation contract, rule 3): every resolved key untouched, every
 * DEFERRED key removed — a live `Promise` is not JSON-safe, and its
 * settlement streams separately as a `__WARLOCK_DEFER__` chunk
 * (`server/defer-emission.ts`), never inlined here. A page with no deferred
 * keys returns `pageData` completely unchanged.
 */
function wirePageData(pageData: unknown, deferredKeys: string[] | undefined): unknown {
  const resolved = serializableData(pageData);

  if (deferredKeys === undefined || deferredKeys.length === 0) return resolved;
  if (typeof resolved !== "object" || resolved === null) return resolved;

  const wire: Record<string, unknown> = { ...(resolved as Record<string, unknown>) };

  for (const key of deferredKeys) delete wire[key];

  return wire;
}

export function buildHydrationPayload(
  bundle: PageDataBundle,
  locale: string,
): HydrationDocumentPayloadSource {
  const appData = serializableData(bundle.appData);
  const layoutData = serializableData(bundle.layoutData);
  const pageData = wirePageData(bundle.pageData, bundle.deferredKeys);

  // devalue is the wire format for every one of these (the ruling this file's
  // header already enforces for SHAPE now also covers SERIALIZABILITY): a
  // class instance, function or symbol a loader returned is caught HERE, with
  // the level and route attached, rather than surfacing later as an opaque
  // devalue throw from whichever wire path happens to serialize the combined
  // payload first.
  assertPageDataSerializable(appData, "app", bundle.route.name);
  assertPageDataSerializable(layoutData, "layout", bundle.route.name);
  assertPageDataSerializable(pageData, "page", bundle.route.name);

  return {
    appData,
    layoutData,
    pageData,
    shared: serializableData(bundle.shared),
    // The server's own match, carried for the same reason `name` is: the params
    // are an ANSWER the router already gave, and re-deriving them in the
    // browser from `location.pathname` would be a second matcher disagreeing
    // with the server about the request it is hydrating. `{}` for a route with
    // no dynamic segments — a real answer, not a missing one.
    params: bundle.route.params,
    // Spread, so "the page produced no metadata" is the SAME shape here and on
    // the wire. `metadata: undefined` would be a key in the in-process object
    // and no key at all after `JSON.stringify` — one type, two payload shapes,
    // which is precisely the drift this file exists to prevent. Carried whole:
    // `<Head/>` renders every member of `MetadataOutput`, so anything narrowed
    // out here is a tag the first request has and a navigation does not.
    ...(bundle.metadata === undefined ? {} : { metadata: bundle.metadata }),
    ...(bundle.errorPage === undefined ? {} : { errorPage: bundle.errorPage }),
    // The matched entry's own name, carried untransformed from stage 1
    // (`bundle.route.name` IS `matched.entry.name`, execute-page-request.ts).
    // The browser reads it to look up the page the server resolved rather than
    // re-matching the pathname — a second matcher can disagree with the server
    // about the very request it is hydrating, and on a client navigation it
    // would be disagreeing about a request the server already answered.
    name: bundle.route.name,
    locale,
    // ONLY `locale`'s own keywords — never `getTranslationsList()`'s full
    // table, which is every OTHER locale core globbed at boot too. `??  {}`
    // rather than propagating `null`: a locale with no registered keywords is
    // a valid, empty table for the browser, not a malformed payload
    // (`hydration-payload.ts`'s gate requires `translations` to be an
    // object).
    translations: getKeywordsListOf(locale) ?? {},
    // Same optional/never-empty rule as `metadata`/`errorPage` above — see
    // `HydrationDocumentPayloadSource.deferred`'s own doc comment.
    ...(bundle.deferredKeys === undefined || bundle.deferredKeys.length === 0
      ? {}
      : { deferred: bundle.deferredKeys }),
  };
}
