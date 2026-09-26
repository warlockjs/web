import { config, type Request, type Response } from "@warlock.js/core";

import type { PageCacheOptIn } from "../../routing/route-identity";
import { computePageCacheKey, type PageCacheVariant } from "../page-cache-key";
import { getPageCacheEntry } from "../page-cache-store";
import { markPageResponse } from "../set-cookie-cache-floor-hook";
import { pageVaryHeader } from "../page-vary-header";
import {
  isNoncedDocumentCache,
  PAGE_CACHE_REPLAY_SKIPPED_HEADERS,
  reportPageCacheFailure,
} from "./store-page-cache-after-render";
import { persistRequestedLocale } from "./persist-requested-locale";

type SelectedPageSite = {
  key: string;
  tenantKey?: string;
};

/**
 * Decides the host a page cache entry is keyed under. For a selected site, the
 * host has already passed site selection, so it is lowercased (with its port)
 * and never bypasses because of `app.url`. Without a selected site, `app.url`
 * permits only its configured host (case-insensitive, port-aware); a foreign
 * request host returns `"bypass"` — no lookup and no store. Without `app.url`
 * (or if it is unparsable), the request host is used.
 */
export function resolvePageCacheHost(requestHost: string, site?: SelectedPageSite): string | "bypass" {
  if (site !== undefined) return requestHost.toLowerCase();

  const configured = config.get("app.url") as string | undefined;

  if (!configured) return requestHost;

  let configuredHost: string;

  try {
    configuredHost = new URL(configured).host.toLowerCase();
  } catch {
    return requestHost;
  }

  return requestHost.toLowerCase() === configuredHost ? requestHost : "bypass";
}

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
  translationsRevision?: string;
  /** Runs app, layout and page middleware; called only when a HIT was found. */
  middlewareGate?: () => Promise<"passed" | "sent" | "blocked">;
}):Promise<PageCacheLookupOutcome> {
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

  // A nonce'd HTML document is never stored or replayed — see
  // `isNoncedDocumentCache`. The JSON variant carries no nonce and still caches.
  if (isNoncedDocumentCache(pageCacheVariant)) {
    return {
      served: false,
      cacheHeaderValue: "bypass",
      cacheKey: undefined,
      attemptStorageAfterRender: false,
    };
  }

  const site = (request as { site?: SelectedPageSite }).site;
  const cacheHost = resolvePageCacheHost(String(request.header("host", "") ?? ""), site);

  if (cacheHost === "bypass") {
    return {
      served: false,
      cacheHeaderValue: "bypass",
      cacheKey: undefined,
      attemptStorageAfterRender: false,
    };
  }

  const cacheKey = computePageCacheKey({
    host: cacheHost,
    vary: cache.varyBy?.(request),
    path: request.path,
    query: request.query as Record<string, unknown>,
    queryAllowlist: (cache as PageCacheOptIn & { query?: string[] }).query,
    locale: request.locale,
    variant: pageCacheVariant,
    translationsRevision: options.translationsRevision,
    site: site?.key,
    tenantKey: site?.tenantKey,
  });

  let hit: Awaited<ReturnType<typeof getPageCacheEntry>>;

  try {
    hit = await getPageCacheEntry(cacheKey);
  } catch (error) {
    // Backend down: render uncached, and skip a store that would fail the same way.
    reportPageCacheFailure("lookup", error);

    return { served: false, cacheHeaderValue: "miss", cacheKey, attemptStorageAfterRender: false };
  }

  if (hit === undefined) {
    return { served: false, cacheHeaderValue: "miss", cacheKey, attemptStorageAfterRender: true };
  }

  // Middleware is the gate; the cache sits behind it. An allowlist, geo-block
  // or maintenance middleware must stop a HIT exactly as it stops a render.
  if (options.middlewareGate !== undefined) {
    const gate = await options.middlewareGate();

    // The middleware wrote the whole reply itself.
    if (gate === "sent") return { served: true };

    // It halted without replying: the full pipeline renders that outcome, and
    // nothing rendered for a blocked visitor is ever stored under this key.
    if (gate === "blocked") {
      return {
        served: false,
        cacheHeaderValue: "bypass",
        cacheKey: undefined,
        attemptStorageAfterRender: false,
      };
    }
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

  // Headers the MISS committed (robots, preload links, content-language...).
  // Those set explicitly here and per-response framing headers win.
  for (const [name, value] of Object.entries(hit.headers ?? {})) {
    if (PAGE_CACHE_REPLAY_SKIPPED_HEADERS.has(name.toLowerCase())) continue;

    response.header(name, value);
  }

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
