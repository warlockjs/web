import { stringify } from "devalue";

import type { Request, Response } from "@warlock.js/core";

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

  if (!eligible) return empty;

  const ttl = cache.ttl ?? cache.maxAge;
  const tags = resolveCacheTags(cache.tags, rendered.data, rendered.bundle?.shared);
  const maxEntryBytes = resolvePageCacheMaxEntryBytes();

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

          await setPageCacheEntry(
            cacheKey,
            {
              body: limited.body,
              status: 200,
              contentType: "text/html",
              usesDefer: rendered.usesDefer ?? false,
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
      await setPageCacheEntry(
        cacheKey,
        {
          body: rendered.html,
          status: 200,
          contentType: "text/html",
          usesDefer: rendered.usesDefer ?? false,
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
    await setPageCacheEntry(
      cacheKey,
      {
        body: precomputedJsonBody,
        status: 200,
        contentType: DATA_RESPONSE_CONTENT_TYPE,
        usesDefer: rendered.usesDefer ?? false,
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
