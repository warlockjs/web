/**
 * Write the NDJSON representation of a client-navigation DATA request, for a
 * page that deferred one or more loader keys, to a client that sent `Accept:
 * application/x-ndjson`.
 *
 * Line 1 is the ordinary hydration payload — `deferred` included, deferred
 * `pageData` keys omitted — the SAME object `buildHydrationPayload` already
 * produces for every other representation, so a client reading only line 1
 * sees exactly what today's fully-buffered JSON response would have shown.
 * Each further line streams one `{ defer, settlement }` record the instant
 * ITS OWN settlement resolves, so the wire order is the real settlement
 * order — never declaration order — mirroring `defer-emission.ts`'s
 * document-path chunk ordering without importing anything from it: that file
 * owns the DOCUMENT's post-shell `<script>` chunks, this owns the DATA
 * request's NDJSON lines, a separate wire format for a separate consumer
 * (`web/src/client/navigation/fetch-page-data.ts`).
 *
 * Status and headers are the CALLER's decision, applied before this runs
 * (contract rule 10: "Status and headers are decided before line 1") — this
 * function sets the content type and status exactly once, before writing
 * anything, and never again.
 */
import type { Request, Response } from "@warlock.js/core";
import { stringify } from "devalue";
import { buildHydrationPayload } from "./build-hydration-payload";
import type { DeferSettlement } from "./defer-settlement";
import { serializePageError } from "./error-page";
import { pathnameFromRequest, type ServerErrorContext } from "./error-reporting-config";
import type { PageDataBundle } from "./execute-page-request";
import { assertPageDataSerializable } from "./page-data-serialization-error";
import { reportServerError } from "./report-server-error";

/** The wire content type for a Stage 2 slice S3 streaming data response. */
export const NDJSON_CONTENT_TYPE = "application/x-ndjson";

/**
 * One line of the NDJSON body after line 1 — contract rule 10. `settlement`
 * is devalue's `stringify` output for the {@link DeferSettlement} value, kept
 * as a STRING field rather than spliced in as raw devalue text: devalue's
 * output is JSON-compatible but not itself valid JSON *inside* an outer JSON
 * object without being treated as a nested value, and wrapping it as a string
 * keeps the outer `{"defer":...,"settlement":...}` shape parseable with a
 * plain `JSON.parse` before the inner devalue text is decoded separately —
 * the same two-step read `fetch-page-data.ts` already does for a document's
 * deferred chunk script argument.
 */
export type DeferredNdjsonLine = { defer: string; settlement: string };

/**
 * Write the full NDJSON response for `bundle` onto `response`'s raw Node
 * stream.
 *
 * Assumes `bundle.deferredKeys` is non-empty — the only caller
 * (`create-page-route-handler.ts`) reaches this exclusively when that is
 * true; a page with no deferred keys stays on the ordinary JSON path
 * unconditionally, so this function is never asked to produce a one-line
 * NDJSON body.
 */
export async function writeDeferredNdjsonResponse(
  response: Response,
  bundle: PageDataBundle,
  locale: string,
  status: number,
  /** Reporting context only (card 1db238ca) — never read for anything else here. */
  request?: Request,
): Promise<void> {
  const deferredKeys = bundle.deferredKeys ?? [];
  const settlements = bundle.deferredSettlements ?? {};
  const buildReportContext = (phase: string): ServerErrorContext => ({
    kind: "defer",
    phase,
    routeName: bundle.route.name,
    routePath: bundle.route.path,
    pathname: pathnameFromRequest(request),
    method: request?.method ?? "unknown",
    requestId: request?.id,
  });
  // The ONE per-request abort signal (`request-abort-signal.ts`, carried on
  // the bundle by `execute-page-request.ts`) — fires when the client
  // disconnects before this response finished (card a84d0644).
  const signal = bundle.abortSignal;

  response.setContentType(NDJSON_CONTENT_TYPE);
  response.setStatusCode(status);

  const raw = response.raw;

  // Past this point, headers and line 1 are already on the wire — a failure
  // can never attempt a fresh response, only guarantee `raw.end()` fires
  // exactly once (success, a deferred key's own rejection, a serialization
  // failure caught below, the writer itself erroring, or the client
  // disconnecting).
  let ended = false;
  const endOnce = (): void => {
    if (ended) return;
    ended = true;
    raw.end();
  };
  raw.once("error", (error) => {
    reportServerError(
      "NDJSON response's destination stream errored",
      error,
      buildReportContext("destination-stream-error"),
    );
    endOnce();
  });

  response.flushPendingCookies();
  raw.writeHead(response.statusCode, response.getHeaders() as never);

  // devalue's output is JSON-compatible text with no raw newlines, so this
  // stays a well-formed NDJSON line 1 unchanged.
  raw.write(`${stringify(buildHydrationPayload(bundle, locale))}\n`);

  if (signal?.aborted) {
    endOnce();
    return;
  }

  // Each entry writes independently, the instant ITS OWN settlement
  // resolves — never chained one after another — so the line order on the
  // wire is the real settlement order, not declaration order (mirrors
  // `defer-emission.ts`'s document-path emission).
  const settlementsWritten = Promise.all(
    deferredKeys.map((key) => {
      const settlement =
        settlements[key] ?? Promise.resolve<DeferSettlement>({ ok: true, value: undefined });

      return settlement.then((value) => {
        // A disconnect mid-settlement stops every remaining line — `raw` is
        // already ending/ended by the abort race below.
        if (signal?.aborted) return;

        let line: DeferredNdjsonLine;

        try {
          assertPageDataSerializable(value, "page", bundle.route.name);
          line = { defer: key, settlement: stringify(value) };
        } catch (thrown) {
          // Line 1 is already flushed — this can never become a second
          // response attempt. Settle the key in-band, on the SAME wire
          // shape the client already understands for a rejected deferred
          // value, and report through the same unconditional stderr floor
          // a render-time throw uses (`render-page.ts`'s `reportRenderError`).
          // The error's own `errorCode` (production only) is folded into
          // this same report line so an operator can join the two.
          const error = serializePageError(thrown);
          const errorSettlement: DeferSettlement = { ok: false, error };
          reportServerError(
            `deferred value "${key}" failed to serialize for emission` +
              (error.errorCode ? ` (errorCode ${error.errorCode})` : ""),
            thrown,
            buildReportContext("serialize-failed"),
          );
          line = { defer: key, settlement: stringify(errorSettlement) };
        }

        if (signal?.aborted) return;

        // The outer object is plain JSON (`JSON.stringify`), the inner
        // `settlement` string is devalue text — see the type doc above.
        // `JSON.stringify` never introduces a raw newline, so this line
        // stays single-line NDJSON framing.
        raw.write(`${JSON.stringify(line)}\n`);
      });
    }),
  );

  if (signal === undefined) {
    try {
      await settlementsWritten;
    } finally {
      endOnce();
    }
    return;
  }

  // Race the ordinary completion against the client disconnecting — a
  // disconnect ends `raw` immediately rather than waiting for every
  // remaining deferred key to settle (they may never settle at all).
  await new Promise<void>((resolveRace) => {
    signal.addEventListener("abort", () => resolveRace(), { once: true });
    settlementsWritten.then(
      () => resolveRace(),
      () => resolveRace(),
    );
  });

  endOnce();
}
