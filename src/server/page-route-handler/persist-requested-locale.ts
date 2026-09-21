import type { Request, Response } from "@warlock.js/core";
import { PROVISIONAL_LOCALE_REQUEST_HEADER } from "../../locale-preference";

/**
 * `changeLocaleCode()`'s client half asks for a locale switch by putting
 * `?locale=<code>` on a navigation DATA request's FETCH URL only — never on a
 * document load, and never any other way (`client/navigation/change-locale-code.ts`).
 * Ordinary data requests persist here through the SAME `response.setLocale()` an ordinary
 * controller would call, writes the SAME cookie `request.locale` already read
 * it back from (`core/src/http/request.ts:352-360`), so a later full load
 * agrees without the query param.
 *
 * `request.locale`, not the raw query value: `resolveLocale()` has already run
 * the query value through `cacheLocale()`'s `app.localeCodes` allow-list by
 * the time this runs, so a code outside it is already the configured
 * fallback — and the fallback, not what the client asked for, is what gets
 * persisted.
 *
 * A provisional locale switch is intentionally excluded: the browser writes
 * its preference only after its new page tree is ready. Called from TWO seams
 * that must never disagree: the cache-HIT path
 * (`serve-page-cache-hit.ts`) and the MISS/full-render data path
 * (`send-page-data-response.ts`). A HIT never runs the loader/render pipeline
 * at all — that is the entire point of caching — but it must still run this
 * ONE side effect, or a locale switch served from a warm cache entry returns
 * the right body while silently never persisting the cookie, and the next
 * full load reverts to the old locale (`page-server-cache.spec.ts` — "a HIT
 * still persists a requested locale switch"). A full document load with the
 * same `?locale=` param never calls this — it is gated on `wantsData` by both
 * call sites — so it never persists.
 */
export function persistRequestedLocale(request: Request, response: Response): void {
  // A client-side `changeLocaleCode()` request commits its preference only
  // after its new tree is ready. Persisting the legacy HttpOnly cookie here
  // would make a failed/superseded switch change the next document load.
  if (request.header(PROVISIONAL_LOCALE_REQUEST_HEADER) === "1") return;

  if (typeof request.query["locale"] === "string" && request.query["locale"].length > 0) {
    response.setLocale(request.locale);
  }
}
