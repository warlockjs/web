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
import type { Response } from "@warlock.js/core";
import { stringify } from "devalue";
import { buildHydrationPayload } from "./build-hydration-payload";
import type { DeferSettlement } from "./defer-settlement";
import type { PageDataBundle } from "./execute-page-request";
import { assertPageDataSerializable } from "./page-data-serialization-error";

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
): Promise<void> {
  const deferredKeys = bundle.deferredKeys ?? [];
  const settlements = bundle.deferredSettlements ?? {};

  response.setContentType(NDJSON_CONTENT_TYPE);
  response.setStatusCode(status);

  const raw = response.raw;

  raw.writeHead(response.statusCode, response.getHeaders() as never);

  // devalue's output is JSON-compatible text with no raw newlines, so this
  // stays a well-formed NDJSON line 1 unchanged.
  raw.write(`${stringify(buildHydrationPayload(bundle, locale))}\n`);

  // Each entry writes independently, the instant ITS OWN settlement
  // resolves — never chained one after another — so the line order on the
  // wire is the real settlement order, not declaration order (mirrors
  // `defer-emission.ts`'s document-path emission).
  await Promise.all(
    deferredKeys.map((key) => {
      const settlement =
        settlements[key] ?? Promise.resolve<DeferSettlement>({ ok: true, value: undefined });

      return settlement.then((value) => {
        assertPageDataSerializable(value, "page", bundle.route.name);

        const line: DeferredNdjsonLine = { defer: key, settlement: stringify(value) };

        // The outer object is plain JSON (`JSON.stringify`), the inner
        // `settlement` string is devalue text — see the type doc above.
        // `JSON.stringify` never introduces a raw newline, so this line
        // stays single-line NDJSON framing.
        raw.write(`${JSON.stringify(line)}\n`);
      });
    }),
  );

  raw.end();
}
