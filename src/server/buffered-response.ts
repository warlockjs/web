import type { Response } from "@warlock.js/core";
import type { BufferedCookie } from "./settle-page-response";

export type { BufferedCookie };

/**
 * Replay ONE committed cookie through core's own `Response.cookie()` — the
 * same serializer every ordinary controller's cookie goes through, so there
 * is nothing here for a second implementation to drift from.
 *
 * This is the same one-liner `create-page-route-handler.ts` wires as its
 * production default (`defaultApplyBufferedCookie`); it lives here, too, as
 * the named, importable seam a test (or another dev-only surface) can reach
 * without constructing the whole page route handler.
 */
export function applyBufferedCookie(response: Response, cookie: BufferedCookie): void {
  response.cookie(cookie.name, cookie.value as never, cookie.options ?? {});
}
