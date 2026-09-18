import type { Response } from "@warlock.js/core";

import type { BufferedCookie } from "../execute-page-request";
import type { RenderedPage } from "../render-page";

/**
 * Stage 10a — apply the stage 7 commit (headers, then cookies) to the LIVE
 * response, once, before either terminal write (10b: `html()` or `send()`).
 * Both the document and data representations of a page route go through this
 * so a client navigation never drops a `Set-Cookie` a full load would have
 * kept (`create-page-route-handler.spec.ts` — "applies committed cookies and
 * headers exactly as the document path does").
 */
export function applyCommit(
  response: Response,
  rendered: Pick<RenderedPage, "headers" | "cookies">,
  applyBufferedCookie: (response: Response, cookie: BufferedCookie) => void,
): void {
  response.headers(rendered.headers ?? {});

  for (const cookie of rendered.cookies ?? []) {
    applyBufferedCookie(response, cookie);
  }
}
