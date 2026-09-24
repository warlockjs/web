import { stringify } from "devalue";

import { config, type Request, type Response } from "@warlock.js/core";

import { buildHydrationPayload } from "../build-hydration-payload";
import { DATA_RESPONSE_CONTENT_TYPE } from "../../routing/data-request";
import { isStoreEligible } from "../page-cache-eligibility";
import { type PageCacheVariant } from "../page-cache-key";
import {
  reportPageCacheEntryTooLarge,
  resolvePageCacheMaxEntryBytes,
  tapPipeableStreamForPageCacheLimit,
  type CappablePipeableStream,
} from "../page-cache-entry-limit";
import { setPageCacheEntry } from "../page-cache-store";
import type { PageCacheOptIn } from "../../routing/route-identity";
import type { SharedContext } from "../../index";
import type { RenderedPage } from "../render-page";

/**
 * Resolves a route's `cache.tags` (static list or a function of the
 * resolved page data) into a concrete list at store time. Called with
 * `rendered.data` — the page's own loader data (`RenderedPage.data`,
 * `render-page.ts`) — as the most sensible "data" argument for the function
 * form: it is the same value a page's own component/loader already sees, and
 * is available at this seam without threading anything new through.
 */
export function resolveCacheTags(
  tags: PageCacheOptIn["tags"],
  data: unknown,
  shared: Readonly<SharedContext> | undefined,
): string[] {
  if (tags === undefined) return [];

  return typeof tags === "function" ? tags(data, { shared: shared ?? {} }) : tags;
}

/** Headers a HIT sets itself, or that belong to one specific send, so never stored in or replayed from an entry. */
export const PAGE_CACHE_REPLAY_SKIPPED_HEADERS = new Set([
  "cache-control",
  "vary",
  "set-cookie",
  "content-type",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "x-warlock-cache",
]);

/** The committed headers a HIT may replay, or `undefined` when there are none. */
function replayableHeaders(
  headers: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  const kept: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers ?? {})) {
    if (PAGE_CACHE_REPLAY_SKIPPED_HEADERS.has(name.toLowerCase())) continue;
    if (typeof value !== "string") continue;

    kept[name.toLowerCase()] = value;
  }

  return Object.keys(kept).length > 0 ? kept : undefined;
}

const CACHE_FAILURE_LOG_INTERVAL_MS = 60_000;
let lastCacheFailureLoggedAt = 0;

/** Reports a cache-backend failure at most once a minute, so an outage is not one log line per request. */
export function reportPageCacheFailure(operation: "lookup" | "store", error: unknown): void {
  const now = Date.now();

  if (now - lastCacheFailureLoggedAt < CACHE_FAILURE_LOG_INTERVAL_MS) return;

  lastCacheFailureLoggedAt = now;
  console.warn(`[warlock:web] page-cache ${operation} failed; serving uncached:`, error);
}

/** Test seam: forget the throttle window. */
export function resetPageCacheFailureThrottle(): void {
  lastCacheFailureLoggedAt = 0;
}

/**
 * HTML documents carry the request's CSP nonce on their inline scripts, so a
 * replayed entry would carry the FIRST visitor's nonce and be blocked.
 */
export function isNoncedDocumentCache(variant: PageCacheVariant): boolean {
  return variant === "html" && config.get("http.csp")?.enabled === true;
}

/** Never rejects: a cache-backend failure must not reach the page's catch block. */
async function storeSafely(...args: Parameters<typeof setPageCacheEntry>): Promise<void> {
  try {
    await setPageCacheEntry(...args);
  } catch (error) {
    reportPageCacheFailure("store", error);
  }
}

export type PageCacheStorageAttempt = {
  documentPipeableStreamForSend: CappablePipeableStream | undefined;
  pendingPageCacheWrite: (() => Promise<void>) | undefined;
  precomputedJsonBody: string | undefined;
};

/**
 * Store-time eligibility (lead decision 3) and the actual write, for a
 * store-eligible HTML or JSON MISS. Called only when
 * `attemptStorageAfterRender && cacheKey !== undefined && cache !== undefined`
 * — every other request returns the empty attempt below untouched.
 */
export async function storePageCacheAfterRender(options: {
  request: Request;
  response: Response;
  cache: PageCacheOptIn;
  cacheKey: string;
  authDerivedState: boolean | undefined;
  status: number;
  crawler: boolean;
  rendered: RenderedPage;
  pageCacheVariant: PageCacheVariant;
}): Promise<PageCacheStorageAttempt> {
  const {
    request,
    response,
    cache,
    cacheKey,
    authDerivedState,
    status,
    crawler,
    rendered,
    pageCacheVariant,
  } = options;

  const empty: PageCacheStorageAttempt = {
    documentPipeableStreamForSend: undefined,
    pendingPageCacheWrite: undefined,
    precomputedJsonBody: undefined,
  };

  const eligible = isStoreEligible({
    method: request.method,
    authDerived: authDerivedState,
    response,
    status,
    crawler,
    hasBufferedCookie:
      (rendered.cookies?.length ?? 0) > 0 ||
      Boolean((rendered.headers as Record<string, unknown> | undefined)?.["set-cookie"]),
  });

  if (!eligible || isNoncedDocumentCache(pageCacheVariant)) return empty;

  const ttl = cache.ttl ?? cache.maxAge;
  const tags = resolveCacheTags(cache.tags, rendered.data, rendered.bundle?.shared);
  const maxEntryBytes = resolvePageCacheMaxEntryBytes();
  const headers = replayableHeaders(rendered.headers);

  if (pageCacheVariant === "html") {
    // Store the STREAMED document (already forced to `onAllReady` by
    // `crawler: true` at the call site), never `rendered.html`: that is the
    // synchronous escalation pass, where a `React.lazy` boundary that has not
    // resolved yet in this process renders its Suspense fallback. The visitor
    // on this MISS got the streamed bytes, so the stored entry — and every
    // HIT — must be those same bytes.
    const isMiddlewareBody =
      rendered.bundle?.shortCircuit?.stage === "middleware" &&
      !rendered.bundle.shortCircuit.responseSent;

    if (rendered.pipeableStream !== undefined && !isMiddlewareBody) {
      const tapped = tapPipeableStreamForPageCacheLimit(rendered.pipeableStream, maxEntryBytes);

      return {
        ...empty,
        documentPipeableStreamForSend: tapped.pipeable,
        pendingPageCacheWrite: async () => {
          const limited = await tapped.result;

          if (limited.tooLarge) {
            reportPageCacheEntryTooLarge(limited.bytes, maxEntryBytes);
            return;
          }

          await storeSafely(
            cacheKey,
            {
              body: limited.body,
              status: 200,
              contentType: "text/html",
              usesDefer: rendered.usesDefer ?? false,
              headers,
            },
            ttl,
            tags,
          );
        },
      };
    }

    const bytes = Buffer.byteLength(rendered.html, "utf8");

    if (bytes > maxEntryBytes) {
      reportPageCacheEntryTooLarge(bytes, maxEntryBytes);
    } else {
      void storeSafely(
        cacheKey,
        {
          body: rendered.html,
          status: 200,
          contentType: "text/html",
          usesDefer: rendered.usesDefer ?? false,
          headers,
        },
        ttl,
        tags,
      );
    }

    return empty;
  }

  if (rendered.bundle === undefined) return empty;

  const precomputedJsonBody = stringify(buildHydrationPayload(rendered.bundle, request.locale));
  const bytes = Buffer.byteLength(precomputedJsonBody, "utf8");

  if (bytes > maxEntryBytes) {
    reportPageCacheEntryTooLarge(bytes, maxEntryBytes);
  } else {
    void storeSafely(
      cacheKey,
      {
        body: precomputedJsonBody,
        status: 200,
        contentType: DATA_RESPONSE_CONTENT_TYPE,
        usesDefer: rendered.usesDefer ?? false,
        headers,
      },
      ttl,
      tags,
    );
  }

  // Reused by the caller's data-representation send either way — stored or
  // not, the visitor's own response must still serialize the same bundle,
  // and there is no reason to run `buildHydrationPayload`/`stringify` twice.
  return { ...empty, precomputedJsonBody };
}
