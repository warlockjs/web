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
import {
  DATA_RESPONSE_CONTENT_TYPE,
  WARLOCK_DATA_REQUEST_HEADER,
  WARLOCK_DATA_REQUEST_VALUE,
} from "../../routing/data-request";
import { isHydrationPayload, type HydrationDocumentPayloadSource } from "../../hydration-payload";
import {
  prepareDeferredPageData,
  rejectPendingDeferredKeys,
  settleDeferredValue,
  type DeferredSettlement,
} from "../runtime/defer-registry";

/**
 * Stage 2 slice S3 (`releases/v5.12-streaming-design.md`, contract rule 10):
 * the wire content type of the streaming representation. Kept local to this
 * file (never re-exported) — the server's own copy lives in
 * `web/src/server/write-deferred-ndjson-response.ts`, and the two sides
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
 * One `{ defer, settlement }` line, after line 1 — server-written by
 * `write-deferred-ndjson-response.ts`, read back here.
 */
function isDeferredNdjsonLine(
  value: unknown,
): value is { defer: string; settlement: DeferredSettlement } {
  return (
    isPlainRecord(value) &&
    typeof value.defer === "string" &&
    isPlainRecord(value.settlement) &&
    typeof (value.settlement as { ok?: unknown }).ok === "boolean"
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
    parsed = JSON.parse(firstLine);
  } catch (error) {
    return { type: "hard-navigate", url, reason: `malformed NDJSON payload line: ${String(error)}` };
  }

  if (!isHydrationPayload(parsed)) {
    return { type: "hard-navigate", url, reason: "payload is malformed" };
  }

  const payload = parsed;
  const deferredKeys = payload.deferred ?? [];

  if (deferredKeys.length > 0 && isPlainRecord(payload.pageData)) {
    prepareDeferredPageData(payload.pageData, deferredKeys);
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
          pending.delete(record.defer);
          settleDeferredValue(record.defer, record.settlement);
        }
      }
    } finally {
      if (pending.size > 0) rejectPendingDeferredKeys([...pending]);
    }
  })();

  return { type: "payload", payload, url: response.url || url };
}

export async function fetchPageData(url: string): Promise<PageDataResult> {
  let response: Response;

  try {
    response = await fetch(url, {
      headers: {
        [WARLOCK_DATA_REQUEST_HEADER]: WARLOCK_DATA_REQUEST_VALUE,
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
    });
  } catch (error) {
    // Offline, DNS, CORS, an aborted connection. The browser can render its own
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

  // Checked BEFORE the plain-JSON gate: a page with no deferred keys never
  // gets an ndjson body even when it was accepted (`write-deferred-ndjson-response.ts`
  // is only ever invoked for a page that has some), so this branch is taken
  // only when the server actually chose to stream.
  if (isNdjsonResponse(response)) {
    return readNdjsonPageData(response, url);
  }

  if (!isPayloadResponse(response)) {
    return {
      type: "hard-navigate",
      url,
      reason: `unexpected content-type "${response.headers.get("content-type") ?? "none"}"`,
    };
  }

  let parsed: unknown;

  try {
    parsed = await response.json();
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

  // `response.url` is absolute and reflects any redirect that was followed.
  // Falling back to the requested URL keeps this working under test doubles
  // that do not set it.
  return { type: "payload", payload: parsed, url: response.url || url };
}
