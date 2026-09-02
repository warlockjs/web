/**
 * The `onSend` half of the `Set-Cookie` cache floor.
 *
 * `response-cache-floor.ts`'s `carriesSetCookie` check, run at the
 * `create-page-route-handler.ts` seam, only sees a `Set-Cookie` that was
 * already written to the response BEFORE that seam runs. `@fastify/cookie@10.0.1`
 * does not behave that way for `response.cookie()` / `response.clearCookie()`:
 * `setCookie`/`clearCookie` park the cookie, and it is flushed onto the real
 * `Set-Cookie` header only inside the COOKIE PLUGIN'S OWN `onSend` hook
 * (measured under NODE_ENV=production, test and development —
 * `getHeader("set-cookie")` is `undefined` immediately after `setCookie()`,
 * and the header exists only once that hook has run). The only place this can
 * be observed is a SECOND `onSend` hook, registered to run AFTER the cookie
 * plugin's.
 *
 * REGISTRATION POINT AND WHY IT RUNS AFTER THE COOKIE PLUGIN'S HOOK: Fastify's
 * `addHook("onSend", …)` does not push the hook onto the live list
 * immediately — it queues the push through `this.after(…)` (`fastify.js`'s
 * `addHook`), the same avvio queue `server.register(…)` uses. Avvio drains
 * that queue strictly in the order items were added, and does not move on to
 * the next queued item until the current one — including any nested
 * `addHook`/`register` calls made while it loads — has fully settled. Core's
 * `registerHttpPlugins` (`core/src/http/plugins.ts`) calls
 * `server.register(import("@fastify/cookie"), …)` during `HttpConnector.boot()`.
 * `ensureSetCookieCacheFloorHook` is called from `createPageRouteHandler`,
 * which only ever runs while installing page routes during `WebConnector.boot()`
 * — a LATER `boot()` than `HttpConnector`'s (`web-connector.ts`'s own doc
 * comment on `WEB_CONNECTOR_PRIORITY`, `5.5` vs `5`). So by the time this
 * file's `addHook` call executes, the cookie plugin's registration is already
 * queued ahead of it; avvio resolves the cookie plugin (and the `onSend` hook
 * IT adds from inside its own plugin body) before it ever reaches our
 * later-queued hook. Net effect: cookie's `onSend` hook is pushed onto the
 * hooks array first, ours second, and Fastify runs `onSend` hooks in that
 * push order. `set-cookie-cache-floor.spec.ts`'s registration-order test
 * proves this rather than trusting the reasoning above.
 *
 * SCOPE: registered ONCE, instance-wide, directly on the root Fastify server
 * — not nested inside a `.register()` plugin scope. Fastify only guarantees
 * hook order relative to OTHER items at the SAME encapsulation level, and
 * `@fastify/cookie` is registered on the root instance; nesting ours would
 * put it in an unrelated child context with no ordering guarantee against the
 * root-level plugin at all.
 *
 * Despite being instance-wide, the EFFECT is scoped to page routes only: the
 * hook is a no-op unless the page pipeline explicitly marked the request via
 * `markPageResponse` (called from `create-page-route-handler.ts`, at the same
 * seam that sets `authDerived`). This is deliberate, not a heuristic on URL
 * shape or content-type — inferring "is this a page route" from the request
 * shape is exactly the "one form inspected, a second form reaches the same
 * place unexamined" defect this floor exists to close. An ordinary API
 * response is therefore untouched by this hook's EFFECT, even though the hook
 * FUNCTION itself runs for every response on the instance — widening that
 * effect to every API response is out of scope for this change.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Request as CoreRequest, RequestLocals } from "@warlock.js/core";
import { carriesSetCookie } from "./response-cache-floor";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Mirrors the core `Request`'s `locals` bag onto the raw Fastify request
     * — the only object an `onSend` hook actually receives. Set once, by
     * `markPageResponse`, from the exact same object `request.locals` points
     * at, so later mutations of either reference stay visible through both.
     */
    locals?: RequestLocals;
  }
}

const instrumentedServers = new WeakSet<FastifyInstance>();

/**
 * Mark the current request as a page-pipeline response.
 *
 * Called once per request from `create-page-route-handler.ts`, at the same
 * seam that decides `authDerived`. A no-op when `request.locals` is absent —
 * several existing unit tests hand the page route handler a plain
 * `{ path, header }` mock, never a real core `Request`; treated the same way
 * `applyResponseCacheFloor` treats a missing capability as "not observable".
 */
export function markPageResponse(request: CoreRequest): void {
  if (!request.locals) return;

  request.locals.isPageResponse = true;

  if (request.baseRequest) {
    request.baseRequest.locals = request.locals;
  }
}

/**
 * Register the `Set-Cookie` cache-floor `onSend` hook on `server`, once.
 *
 * Idempotent because `createPageRouteHandler` — the only caller — runs once
 * PER PAGE ROUTE, not once per server; without the guard, a second page route
 * would queue a second, redundant copy of the same hook.
 */
export function ensureSetCookieCacheFloorHook(server: FastifyInstance): void {
  if (instrumentedServers.has(server)) return;

  instrumentedServers.add(server);

  server.addHook(
    "onSend",
    (request: FastifyRequest, reply: FastifyReply, payload: unknown, done) => {
      if (request.locals?.isPageResponse !== true) {
        done(null, payload);
        return;
      }

      if (carriesSetCookie(reply)) {
        reply.header("Cache-Control", "private, no-store");
      }

      done(null, payload);
    },
  );
}
