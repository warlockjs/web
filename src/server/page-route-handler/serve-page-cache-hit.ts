import type { Request, Response } from "@warlock.js/core";

import type { PageCacheOptIn } from "../../routing/route-identity";
import { computePageCacheKey, type PageCacheVariant } from "../page-cache-key";
import { getPageCacheEntry } from "../page-cache-store";
import { markPageResponse } from "../set-cookie-cache-floor-hook";
import { pageVaryHeader } from "../page-vary-header";
import { persistRequestedLocale } from "./persist-requested-locale";

export type PageCacheLookupOutcome =
  | { served: true }
  | {
      served: false;
      cacheHeaderValue: "hit" | "miss" | "bypass" | undefined;
      cacheKey: string | undefined;
      attemptStorageAfterRender: boolean;
    };

/**
 * Server-side page cache (`route.cache.serverCache`,
 * `../../routing/route-identity.ts`'s `PageCacheOptIn`) lookup: computes the
 * cache key, serves a HIT in full (buffered, straight from the store, no
 * loader and no render), or reports back what the caller needs to attempt
 * storage after it renders a MISS itself.
 *
 * Called only when `cache?.serverCache === true` — every other route is
 * completely untouched by this module.
 */
export async function resolvePageCacheHitOrMiss(options: {
  request: Request;
  response: Response;
  cache: PageCacheOptIn;
  credentialedRequest: boolean;
  pageCacheVariant: PageCacheVariant;
}): Promise<PageCacheLookupOutcome> {
  const { request, response, cache, credentialedRequest, pageCacheVariant } = options;

  if (request.method !== "GET") {
    // Decision 3 ("GET only"): a non-GET request to a serverCache route is
    // never looked up and never stored — it flows through the ordinary
    // pipeline below untouched, just reporting a miss-shaped header since
    // nothing was ever cached for it either way.
    return {
      served: false,
      cacheHeaderValue: "miss",
      cacheKey: undefined,
      attemptStorageAfterRender: false,
    };
  }

  if (credentialedRequest) {
    return {
      served: false,
      cacheHeaderValue: "bypass",
      cacheKey: undefined,
      attemptStorageAfterRender: false,
    };
  }

  const cacheKey = computePageCacheKey({
    host: String(request.header("host", "") ?? ""),
    vary: cache.varyBy?.(request),
    path: request.path,
    query: request.query as Record<string, unknown>,
    locale: request.locale,
    variant: pageCacheVariant,
  });

  const hit = await getPageCacheEntry(cacheKey);

  if (hit === undefined) {
    return { served: false, cacheHeaderValue: "miss", cacheKey, attemptStorageAfterRender: true };
  }

  // A HIT is always served buffered, straight from the store, with no loader
  // and no render — see `render-page.ts`'s await-and-inline path, reused only
  // on the MISS side.
  markPageResponse(request);

  // BEFORE the early return, and before the `Cache-Control` below: a
  // navigation data request's `?locale=` switch must persist even when served
  // from the cache — see `persistRequestedLocale`. When it does write a
  // cookie, the `Set-Cookie` cache-floor `onSend` hook
  // (`set-cookie-cache-floor-hook.ts`) then downgrades the `Cache-Control`
  // this seam is about to set to `private, no-store` at send time — the same
  // floor a MISS gets from `applyResponseCacheFloor`, just applied one hook
  // later.
  if (pageCacheVariant === "json") {
    persistRequestedLocale(request, response);
  }

  // Replays exactly what a MISS on this same route would emit: the opt-in
  // already requires `public: true`, so this is the same `Cache-Control`
  // `applyResponseCacheFloor` would compute for a store-eligible response
  // (`authDerived === false`, no cookie — both already proven true of
  // whatever got stored).
  response.header("Cache-Control", `public, max-age=${cache.maxAge}`);
  response.header("x-warlock-cache", "hit");

  // ONE `header()` call for the whole response — see `pageVaryHeader`'s doc
  // comment on why a second call would silently overwrite this one instead of
  // combining with it. A HIT is only ever reached for a
  // `cache.serverCache === true` route, so `cache` is always defined here.
  response.header(
    "Vary",
    pageVaryHeader({
      dataRepresentation: pageCacheVariant === "json",
      cacheOptedIn: true,
      deferred: hit.usesDefer,
    }),
  );

  if (pageCacheVariant === "json") {
    response.setContentType(hit.contentType);
    await response.send(hit.body, hit.status);
  } else {
    await response.html(hit.body, hit.status);
  }

  return { served: true };
}
