import { stringify } from "devalue";

import type { Request, Response } from "@warlock.js/core";

import { DATA_RESPONSE_CONTENT_TYPE } from "../../routing/data-request";
import { buildHydrationPayload } from "../build-hydration-payload";
import type { RenderedPage } from "../render-page";
import { writeDeferredNdjsonResponse } from "../write-deferred-ndjson-response";
import { persistRequestedLocale } from "./persist-requested-locale";

/**
 * Writes the DATA representation of a page route response — the branch
 * reached only when `wantsData` is true. Every path through this function
 * terminates the request; there is nothing left for the caller to do
 * afterward.
 */
export async function sendPageDataResponse(options: {
  request: Request;
  response: Response;
  rendered: RenderedPage;
  status: number;
  wantsNdjson: boolean;
  precomputedJsonBody: string | undefined;
}): Promise<void> {
  const { request, response, rendered, status, wantsNdjson, precomputedJsonBody } = options;

  // See `persistRequestedLocale` — the cache HIT branch (`serve-page-cache-hit.ts`)
  // calls the same function, for the same reason.
  persistRequestedLocale(request, response);

  // `Vary` is already set by the caller, once, for both representations.

  // `bundle` is absent on exactly one path: nothing matched, so no pipeline
  // ran and there is no payload to build. Fastify already matched this route
  // to get here, so reaching it means `request.path` did not satisfy the
  // entry's own pattern — answered as the 404 it is, rather than
  // synthesising an empty payload the client would try to render as a page.
  if (rendered.bundle === undefined) {
    response.setContentType(DATA_RESPONSE_CONTENT_TYPE);
    await response.send(JSON.stringify({ error: "not_found" }), status);

    return;
  }

  // Stage 2 slice S3 (contract rule 10): a page that deferred at least one
  // key, asked for over `Accept: application/x-ndjson`, streams instead of
  // answering one buffered JSON body. A page with no deferred keys is
  // UNCHANGED under either `Accept` value — it never reaches this branch,
  // `deferredKeys` is undefined/empty for it.
  const deferredKeys = rendered.bundle.deferredKeys;

  if (wantsNdjson && deferredKeys !== undefined && deferredKeys.length > 0) {
    await writeDeferredNdjsonResponse(response, rendered.bundle, request.locale, status);

    return;
  }

  // SERIALIZED HERE, and handed over as a STRING on purpose.
  //
  // `response.send(object)` runs the body through core's `Response.parse`,
  // which recurses the object, calls `toJSON()` on anything that has one
  // (assigning `request` onto it as it goes) and rebuilds arrays. That is the
  // right behaviour for a controller returning Resources; it is the wrong
  // behaviour here, because the DOCUMENT path serializes this exact object
  // with devalue's `stringify` into `#__WARLOCK_DATA__`. Routing one path
  // through a transformer and not the other is precisely the drift
  // `build-hydration-payload.ts` exists to prevent — the browser would build
  // one tree on a page load and a different one on a navigation to the same
  // URL.
  //
  // A string body also bypasses `parseBody()` entirely, so the content type
  // has to be declared rather than inferred from an object body.
  //
  // CONTENT TYPE: kept as `DATA_RESPONSE_CONTENT_TYPE` (`application/json`)
  // deliberately. devalue's `stringify` output is syntactically valid JSON
  // text — it only recurses `["Date", ...]`/`["Map", ...]`-shaped arrays and
  // reference indices instead of the literal object graph, so `JSON.parse`
  // never throws on it, it just does not reconstruct the same value devalue
  // does. `application/json` here documents "the bytes are valid JSON",
  // which is true; the semantic decode is `readHydrationPayload`'s job, not
  // this response's content type.
  response.setContentType(DATA_RESPONSE_CONTENT_TYPE);
  await response.send(
    precomputedJsonBody ?? stringify(buildHydrationPayload(rendered.bundle, request.locale)),
    status,
  );
}
