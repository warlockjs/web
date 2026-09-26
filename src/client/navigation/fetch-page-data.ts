/**
 * Ask the server for a URL's page data instead of its document.
 *
 * This is the browser half of the representation split: the same route the user
 * would have loaded, asked for as JSON via the `x-warlock-data` marker. What
 * comes back is exactly the payload a full page load embeds, so the caller can
 * rebuild the tree from it with no second code path.
 *
 * ## Every failure degrades to a REAL navigation, never to an error screen
 *
 * A client navigation is an OPTIMISATION over what the browser already does
 * perfectly well. So nothing here reports a failure to the user — it reports
 * `hard-navigate`, and the caller hands the URL back to the browser. The user
 * gets the page; they just get it the slow way.
 *
 * That is what makes the whole feature safe to add: the worst case of a bug in
 * this file is the behaviour we had before the file existed. Rendering our own
 * "navigation failed" state would be strictly worse than the fallback we
 * already have, and would turn every unhandled edge — an auth redirect to an
 * external IdP, a maintenance page, a proxy that strips the header, a deploy
 * that changed the payload shape mid-session — into a dead end.
 */
import { parse } from "devalue";
import {
  DATA_RESPONSE_CONTENT_TYPE,
  WARLOCK_DATA_REQUEST_HEADER,
  WARLOCK_DATA_REQUEST_VALUE,
} from "../../routing/data-request";
import { isHydrationPayload, type HydrationDocumentPayloadSource } from "../../hydration-payload";
import { currentHydrationSite } from "../hydrate-site";
import {
  prepareDeferredPageData,
  rejectPendingDeferredKeys,
  releaseDeferredScope,
  settleDeferredValue,
  type DeferredSettlement,
} from "../runtime/defer-registry";
import { createSettledThenable } from "../../loaders/settled-thenable";
import { PROVISIONAL_LOCALE_REQUEST_HEADER } from "../../locale-preference";

/**
 * The wire content type of the streaming (deferred-values) representation.
 * Kept local to this file (never re-exported) — the server's own copy lives
 * in `web/src/server/write-deferred-ndjson-response.ts`, and the two sides
 * agreeing on the STRING is the whole contract; nothing here needs the
 * server's module.
 */
const NDJSON_CONTENT_TYPE = "application/x-ndjson";

export type PageDataResult =
  | {
      type: "payload";
      /**
       * The payload to rebuild the tree from.
       */
      payload: HydrationDocumentPayloadSource;
      /**
       * The URL the response actually came from — NOT the one requested. A
       * redirect is followed by `fetch` transparently, so a login-required page
       * answers from `/login`, and pushing the requested URL into history would
       * leave the address bar lying about what is on screen.
       */
      url: string;
    }
  | {
      type: "hard-navigate";
      url: string;
      /** Why, for a console warning — never shown to the user. */
      reason: string;
    }
  | {
      /**
       * The request was aborted through the `signal` the caller passed in —
       * a newer navigation, refresh or locale change claimed the ticket
       * before this one's response arrived. NOT a `hard-navigate`: the
       * ticket counter (`navigation-root.tsx`'s `claimTicket`) is the
       * arbiter of which response wins, and it already dropped this one —
       * this result exists only so the caller does not mistake ITS OWN
       * cancellation for a network failure and warn about, or fall back
       * from, a question it stopped asking.
       */
      type: "aborted";
      url: string;
    };

/**
 * Whether the body is the payload we asked for.
 *
 * Checked rather than assumed because a 200 does not mean "this came from the
 * page pipeline": a captive portal, an SSO interstitial or a proxy error page
 * all answer 200 with HTML. Parsing that as JSON would throw; treating a
 * successful parse of *something else* as a payload would render garbage.
 */
function isPayloadResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes(DATA_RESPONSE_CONTENT_TYPE);
}

/** Whether the body is the Stage 2 slice S3 streaming representation. */
function isNdjsonResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes(NDJSON_CONTENT_TYPE);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * RELEASE BLOCKER fix: a `serverCache` route's JSON (non-NDJSON) data
 * representation never streams (docs, "page-caching.mdx") — every deferred
 * key the loader returned as a promise has already been awaited on the
 * server and put back on the wire as its plain, resolved value
 * (`render-page.ts`'s `restoreInlineDeferredForDataWire`,
 * `build-hydration-payload.ts`'s `inlinedDeferredKeys`). The page component
 * still calls `use(data.thatKey)` unconditionally, and React's `use()`
 * throws ("An unsupported type was passed to use()", minified #438) on
 * anything that is not a thenable — a bare value included.
 *
 * This is the client-side half of that fix: for every key `payload.deferred`
 * lists AND that is still present on `payload.pageData` (the NDJSON path
 * deletes it instead — see `readNdjsonPageData`, which never calls this),
 * wrap the already-known value in the SAME already-fulfilled thenable shape
 * `createSettledThenable` builds for the server's own inline paths (crawler
 * documents, `render-page.ts`), so `use()` reads it synchronously with no
 * suspend. Mutates `payload.pageData` in place, same convention as
 * `prepareDeferredPageData`.
 *
 * A rejected deferred key never reaches this function: the server's
 * await-and-inline path escalates a rejection to the page-level error
 * boundary instead of inlining a per-key failure (`render-page.ts`), so the
 * wire never encodes one here — there is nothing for this function to turn
 * into a rejected thenable.
 */
function reviveInlinedDeferredValues(payload: HydrationDocumentPayloadSource): void {
  const deferredKeys = payload.deferred;

  if (deferredKeys === undefined || deferredKeys.length === 0) return;
  if (!isPlainRecord(payload.pageData)) return;

  const pageData = payload.pageData;

  for (const key of deferredKeys) {
    if (!Object.prototype.hasOwnProperty.call(pageData, key)) continue;

    pageData[key] = createSettledThenable(pageData[key]);
  }
}

/**
 * One counter per module load, incremented per NDJSON navigation, so two
 * overlapping `fetchPageData` calls (e.g. a fast double-click, or a prefetch
 * still in flight when the user navigates again) never share a deferred-
 * registry scope. A plain counter is enough: it only has to be unique within
 * this one `window`'s lifetime, never across page loads.
 */
let navigationScopeCounter = 0;

function createNavigationScope(): string {
  navigationScopeCounter += 1;
  return `navigation:${navigationScopeCounter}`;
}

/**
 * One `{ defer, settlement }` line, after line 1 — server-written by
 * `write-deferred-ndjson-response.ts`, read back here. `settlement` is
 * devalue-serialized TEXT (a string), decoded separately — see
 * {@link readNdjsonPageData}'s per-line loop.
 */
function isDeferredNdjsonLine(value: unknown): value is { defer: string; settlement: string } {
  return (
    isPlainRecord(value) && typeof value.defer === "string" && typeof value.settlement === "string"
  );
}

/**
 * A line-at-a-time reader over a `Response.body` stream. NDJSON lines are
 * newline-delimited, and `fetch`'s body arrives in arbitrary byte chunks that
 * do not respect that boundary — this buffers across chunks and yields one
 * complete line per call, `undefined` once the stream has ended with nothing
 * left buffered.
 */
function createLineReader(body: ReadableStream<Uint8Array>): () => Promise<string | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  return async function readLine(): Promise<string | undefined> {
    for (;;) {
      const newlineIndex = buffered.indexOf("\n");

      if (newlineIndex !== -1) {
        const line = buffered.slice(0, newlineIndex);
        buffered = buffered.slice(newlineIndex + 1);

        return line;
      }

      const { done, value } = await reader.read();

      if (done) {
        if (buffered.length === 0) return undefined;

        const line = buffered;
        buffered = "";

        return line;
      }

      buffered += decoder.decode(value, { stream: true });
    }
  };
}

/**
 * Read the Stage 2 slice S3 streaming representation: line 1 is the ordinary
 * payload (contract rule 10) and resolves this function immediately — the
 * caller renders from it at once, exactly like a plain JSON response, with
 * each deferred key a PENDING promise in the same registry `hydratePage` uses
 * (`prepareDeferredPageData`). Every later line is read and applied in the
 * background: settling the matching registry entry as it arrives
 * (`settleDeferredValue`), or, if the stream ends with keys still
 * outstanding, rejecting exactly those with `DeferredStreamClosedError`
 * (`rejectPendingDeferredKeys` — contract rule 8, applied to a navigation
 * instead of the hydration document). That background work is deliberately
 * NOT part of this function's own returned promise: waiting on it would
 * defeat the entire point of streaming.
 */
async function readNdjsonPageData(response: Response, url: string): Promise<PageDataResult> {
  const body = response.body;

  if (body === null) {
    return { type: "hard-navigate", url, reason: "ndjson response has no readable body" };
  }

  const readLine = createLineReader(body);
  const firstLine = await readLine();

  if (firstLine === undefined) {
    return { type: "hard-navigate", url, reason: "ndjson stream ended before the payload line" };
  }

  let parsed: unknown;

  try {
    // devalue is the page-data wire format: line 1 is devalue-serialized
    // text, not plain JSON — see `write-deferred-ndjson-response.ts`.
    parsed = parse(firstLine);
  } catch (error) {
    return {
      type: "hard-navigate",
      url,
      reason: `malformed NDJSON payload line: ${String(error)}`,
    };
  }

  if (!isHydrationPayload(parsed)) {
    return { type: "hard-navigate", url, reason: "payload is malformed" };
  }

  const payload = parsed;
  const deferredKeys = payload.deferred ?? [];
  // Own scope per navigation: two overlapping `fetchPageData` calls that both
  // defer a same-named key (e.g. two product pages both deferring "reviews")
  // must not resolve into each other's registry entry.
  const scope = createNavigationScope();

  if (deferredKeys.length > 0 && isPlainRecord(payload.pageData)) {
    prepareDeferredPageData(payload.pageData, deferredKeys, scope);
  }

  void (async () => {
    const pending = new Set(deferredKeys);

    try {
      for (;;) {
        const line = await readLine();

        if (line === undefined) break;
        if (line.length === 0) continue;

        let record: unknown;

        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }

        if (isDeferredNdjsonLine(record)) {
          let settlement: DeferredSettlement;

          try {
            settlement = parse(record.settlement) as DeferredSettlement;
          } catch {
            // Left in `pending`: the `finally` rejects it, and only a settled
            // key is removed by `releaseDeferredScope`.
            continue;
          }

          pending.delete(record.defer);
          settleDeferredValue(record.defer, settlement, scope);
        }
      }
    } catch {
      // The stream broke — most commonly because the SAME `signal` that
      // aborted this navigation's `fetch()` also aborts its still-streaming
      // body reads. Swallowed rather than surfaced: this background reader
      // has no caller left to report to, and the `finally` below already
      // does the one thing that still matters — this scope's keys must not
      // be left pending forever.
    } finally {
      if (pending.size > 0) rejectPendingDeferredKeys([...pending], scope);

      // This scope's own settlement traffic is now fully drained — nothing
      // will ever call `settleDeferredValue`/`rejectPendingDeferredKeys` for
      // it again, whether this navigation's payload ever gets applied or was
      // superseded first. See `releaseDeferredScope`'s own doc.
      releaseDeferredScope(scope);
    }
  })();

  return { type: "payload", payload, url: response.url || url };
}

/**
 * @param signal Wired to `fetch()` so a caller (`navigation-root.tsx`,
 * `refresh.ts`, `change-locale-code.ts`) can cancel an in-flight request once
 * a newer one has taken its ticket. This is an OPTIMISATION on top of the
 * ticket counter, not a substitute for it: aborting merely stops the browser
 * doing wasted work sooner, and the ticket is what a caller must still check
 * before acting on the result — a superseded fetch that resolves anyway
 * (ignored `signal`, or a race between abort and response) is dropped by the
 * ticket exactly as before this parameter existed.
 */
export type FetchPageDataOptions = {
  /** Do not let the server persist its legacy locale cookie for this request. */
  provisionalLocale?: boolean;
  /** The site that booted this client; absent preserves single-site behaviour. */
  site?: string;
};

export async function fetchPageData(
  url: string,
  signal?: AbortSignal,
  options: FetchPageDataOptions = {},
): Promise<PageDataResult> {
  let response: Response;

  try {
    response = await fetch(url, {
      headers: {
        [WARLOCK_DATA_REQUEST_HEADER]: WARLOCK_DATA_REQUEST_VALUE,
        ...(options.provisionalLocale ? { [PROVISIONAL_LOCALE_REQUEST_HEADER]: "1" } : {}),
        // NDJSON preferred, but a plain-JSON server is honoured just the
        // same — this list is a preference order, not a requirement.
        accept: `${NDJSON_CONTENT_TYPE}, ${DATA_RESPONSE_CONTENT_TYPE}`,
      },
      // Same-origin credentials so a navigation carries the session exactly as
      // a document request would. Without this a client navigation could be
      // logged out while a full load of the same URL is not.
      credentials: "same-origin",
      // Redirects are FOLLOWED, not intercepted: the marker header is re-sent,
      // so the destination answers with a payload too, and `response.url` tells
      // us where we ended up. Handling redirects ourselves would mean
      // re-implementing the rules the browser already has.
      redirect: "follow",
      signal,
    });
  } catch (error) {
    // `signal.aborted` is checked BEFORE the error shape, because an abort's
    // exact error (a `DOMException` named `"AbortError"` in a browser, a
    // plain `Error` under some polyfills/test doubles) is not portable —
    // whether THIS call was cancelled is. Aborted is never a `hard-navigate`:
    // see the `PageDataResult` doc for why conflating the two would be wrong.
    if (signal?.aborted === true) return { type: "aborted", url };

    // Offline, DNS, CORS, a connection reset. The browser can render its own
    // network error far better than we can fake one.
    return { type: "hard-navigate", url, reason: `request failed: ${String(error)}` };
  }

  if (!response.ok) {
    // 404, 500, 403 — all of these have a real page the server renders. Letting
    // the browser load it gets the correct status AND the correct document,
    // rather than us inventing a client-side error state that the server's own
    // error page already covers.
    return { type: "hard-navigate", url, reason: `status ${response.status}` };
  }

  return readPageDataResponse(response, url, options.site ?? currentHydrationSite());
}

/**
 * Turn an already-accepted (2xx) data response into a {@link PageDataResult}:
 * NDJSON or plain devalue JSON, anything else a `hard-navigate`. Shared by
 * `fetchPageData` and `submitPageAction`, so a page action's 200 is read by the
 * exact code a navigation's is.
 */
export async function readPageDataResponse(
  response: Response,
  url: string,
  expectedSite = currentHydrationSite(),
): Promise<PageDataResult> {
  const responseSite = response.headers.get("x-warlock-site");

  if (expectedSite !== undefined && responseSite !== null && responseSite !== expectedSite) {
    void response.body?.cancel().catch(() => undefined);

    return {
      type: "hard-navigate",
      url,
      reason: `site mismatch: expected "${expectedSite}", received "${responseSite}"`,
    };
  }
  // Checked BEFORE the plain-JSON gate: a page with no deferred keys never
  // gets an ndjson body even when it was accepted (`write-deferred-ndjson-response.ts`
  // is only ever invoked for a page that has some), so this branch is taken
  // only when the server actually chose to stream.
  if (isNdjsonResponse(response)) {
    return readNdjsonPageData(response, url);
  }

  if (!isPayloadResponse(response)) {
    // The browser is about to hard-navigate to this URL itself; stop this
    // copy of the body (a file, an API export) from downloading in the background.
    void response.body?.cancel().catch(() => undefined);

    return {
      type: "hard-navigate",
      url,
      reason: `unexpected content-type "${response.headers.get("content-type") ?? "none"}"`,
    };
  }

  let parsed: unknown;

  try {
    // `response.json()` is deliberately NOT used: the body is devalue text,
    // syntactically valid JSON for a payload with no special types but not
    // semantically JSON in general (Date/Map/Set/BigInt/undefined/cyclic
    // references need devalue's own `parse`, never a plain `JSON.parse`).
    parsed = parse(await response.text());
  } catch (error) {
    return { type: "hard-navigate", url, reason: `malformed JSON: ${String(error)}` };
  }

  if (!isHydrationPayload(parsed)) {
    // Deliberately recover through a full document load: malformed navigation
    // data must not crash the client when the server can still render the URL.
    return {
      type: "hard-navigate",
      url,
      reason: "payload is malformed",
    };
  }

  // See `reviveInlinedDeferredValues`'s own doc: a `serverCache` route's JSON
  // representation carries deferred keys as already-resolved plain values, so
  // they must become already-fulfilled thenables before a page's `use()`
  // reads them.
  reviveInlinedDeferredValues(parsed);

  // `response.url` is absolute and reflects any redirect that was followed.
  // Falling back to the requested URL keeps this working under test doubles
  // that do not set it.
  return { type: "payload", payload: parsed, url: response.url || url };
}
