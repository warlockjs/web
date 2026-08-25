/**
 * Two small pieces of the dev/SSR page plumbing that `./web-connector.ts` wires
 * but deliberately does not own: the buffered-cookie commit, and the DEV-ONLY
 * error transport that stops a refused module from reaching the browser as a
 * bare 404 (see {@link devErrorTransportPlugin}).
 *
 * ---
 *
 * Commits one buffered cookie (`BufferedCookie`, from `./buffered-response.ts`)
 * onto the live Warlock `Response` — the single place in the SSR page pipeline
 * where a cookie the loader buffered turns into a real `Set-Cookie` header.
 *
 * It delegates to core's `Response.cookie()` rather than talking to fastify.
 * That method already owns everything this file used to reimplement: it takes
 * core's own `CookieOptions`, JSON-stringifies the value unless `{ raw: true }`,
 * strips the core-only `raw` flag, and layers the framework's secure-cookie
 * defaults and the `http.cookies.options` config under the per-call options.
 * Going through it means the SSR page path and every ordinary controller emit
 * cookies by the exact same code, so the two cannot drift apart.
 *
 * The helper is passed INTO `installPageRoutes`/`createPageRouteHandler` as an
 * option rather than imported by them, which is what keeps this module out of a
 * cycle with the page-route installer.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { stripVTControlCharacters } from "node:util";
import type { Connect, Plugin } from "vite";
import type { Response } from "@warlock.js/core";
import type { BufferedCookie } from "./buffered-response";

/**
 * Replay a buffered cookie onto the response that will actually be sent.
 *
 * `BufferedCookie.options` is a loosely-typed bag (`Record<string, unknown>`)
 * because the buffer is written by loader code before any response exists; the
 * cast hands it to `Response.cookie()`, which is where the option shape is
 * defined and enforced for every other caller in the framework.
 */
export function applyBufferedCookie(response: Response, cookie: BufferedCookie): void {
  response.cookie(cookie.name, cookie.value as never, (cookie.options ?? {}) as never);
}

/**
 * Where a captured transform/resolve failure rides from Vite's connect stack to
 * the Fastify hook that mounted it.
 *
 * A `Symbol.for` key on the raw `IncomingMessage` rather than a `WeakMap`
 * because the two halves live in different modules and are wired at different
 * times; the request object is the only thing they provably share, and the
 * symbol cannot collide with a Vite/Fastify/user property.
 *
 * Exported so a test can stage a captured failure without booting a vite
 * server, and so the two halves cannot drift onto two different keys.
 */
export const DEV_TRANSFORM_ERROR_BODY = Symbol.for("warlock.web.devTransformErrorBody");

type DevTransformErrorCarrier = { [DEV_TRANSFORM_ERROR_BODY]?: string };

/**
 * The status a refused module now answers with.
 *
 * NOT the 404 this replaces. That 404 was never a decision about the module —
 * it is what an unmatched URL gets once vite has declined it, and which of the
 * two framework answers you see depends only on whether the app declares a
 * catch-all page: with one (v5/app does — `path: "*"`) the request lands in the
 * page pipeline, matches no route, and `./render-page.ts:604` returns
 * `{ html: "", status: 404 }` for `./create-page-route-handler.ts:147` to write
 * as an empty `text/html` body; without one it is `core/src/router/router.ts:879`.
 * Either way "the module does not exist" is precisely the wrong thing to tell a
 * developer whose module exists and was refused. 500 is the status VITE ITSELF writes for
 * this exact condition when it is not in middleware mode
 * (`node_modules/vite/dist/node/chunks/config.js:9528`), so this adopts that
 * convention rather than inventing a third one.
 */
export const DEV_TRANSFORM_ERROR_STATUS = 500;

/**
 * `buildErrorMessage` as vite exports it. Declared structurally so this module
 * needs no value import of vite — vite is an optional, dev-only peer and a
 * production install does not carry it.
 */
export type BuildErrorMessage = (
  error: Error,
  args?: string[],
  includeStack?: boolean,
) => string;

/**
 * The dev error transport was constructed while the process is hosting a
 * PRODUCTION build. Refused by name at construction rather than degraded,
 * because everything this transport does — file paths, source frames, plugin
 * names — is exactly what a production response must never carry.
 */
export class DevErrorTransportInProductionError extends Error {
  public constructor() {
    super(
      "The dev error transport was constructed with `Application.runtimeStrategy === " +
        '"production"`. It exists only to put a Vite transform failure in front of a ' +
        "developer and its response body carries absolute file paths and source frames, " +
        "so it must never be mounted on a production-hosted server.",
    );
    this.name = "DevErrorTransportInProductionError";
  }
}

/**
 * Render a refused module's failure as the plain-text body the browser gets.
 *
 * Formatting is DELEGATED to vite's own exported `buildErrorMessage`, not
 * reimplemented: it is the same function vite uses to print the failure to the
 * terminal, so the text a developer reads in the network panel and the text
 * they read in the terminal cannot drift. Two things are added around it —
 * `error.name`, which vite's terminal path replaces with a fixed
 * "Internal server error:" prefix and which is the single most useful token for
 * a named gate refusal (`ProjectionAmbiguityError`), and the `cause` chain,
 * which vite does not walk.
 *
 * `stripVTControlCharacters` is not optional: `buildErrorMessage` colours its
 * output with picocolors, which is ON whenever the dev server owns a TTY, and
 * raw ANSI escapes in an HTTP body are noise. Vite strips them the same way for
 * the overlay payload (`config.js:9490-9497`).
 *
 * The stack is deliberately omitted (`includeStack: false`). A gate refusal's
 * stack points into the gate, not into the developer's code; the fields that
 * locate the problem — plugin, file, line, source frame — are what
 * `buildErrorMessage` puts there without it.
 */
export function formatDevTransformError(
  error: unknown,
  buildErrorMessage: BuildErrorMessage,
): string {
  const failure =
    error instanceof Error ? error : new Error(typeof error === "string" ? error : String(error));

  const lines = [
    stripVTControlCharacters(
      buildErrorMessage(failure, [`${failure.name}: ${failure.message}`], false),
    ),
  ];

  // Walk the `cause` chain. A gate may wrap a parser failure, and the wrapped
  // message is usually the one naming the actual syntax that was refused.
  let cause = (failure as { cause?: unknown }).cause;

  while (cause instanceof Error) {
    lines.push(`  Caused by: ${cause.name}: ${stripVTControlCharacters(cause.message)}`);
    cause = (cause as { cause?: unknown }).cause;
  }

  return `${lines.join("\n")}\n`;
}

/**
 * DEV-ONLY. Capture the transform/resolve failure that vite is about to throw
 * away, so the request that caused it can answer with it.
 *
 * WHY THIS IS A PLUGIN AND NOT A `middlewares.use(...)` CALL — this is the
 * whole defect, and it is an ordering fact, not a style choice:
 *
 *  - Vite mounts its own error handler LAST, built as
 *    `errorMiddleware(server, !!middlewareMode)`
 *    (`node_modules/vite/dist/node/chunks/config.js:25705`).
 *  - In middleware mode that `allowNext` flag is `true`, and the handler then
 *    logs the error to the TERMINAL and calls `next()` — with no error
 *    (`config.js:9525-9527`).
 *  - connect only routes an error to a 4-arity handler while an error is in
 *    flight (`config.js:10611-10626`), so `next()` clears it: every layer after
 *    that point, INCLUDING the `done` callback `./web-connector.ts` hands the
 *    stack, is called as if the request had simply gone unhandled. The
 *    framework then answers the only way it can for a URL it does not know — a
 *    404, empty (see {@link DEV_TRANSFORM_ERROR_STATUS} for which of the two
 *    produces it).
 *  - Anything registered with `vite.middlewares.use(...)` after `createServer()`
 *    resolves lands AFTER that handler and is therefore unreachable. A
 *    `configureServer` POST hook does not: vite runs post hooks at
 *    `config.js:25700`, five lines BEFORE it mounts its error handler.
 *
 * So this sits between the failure and vite's logger. It captures, then calls
 * `next(error)` and lets vite's own handler run exactly as before — the
 * terminal message and the `hot.send({ type: "error" })` overlay push
 * (`config.js:9511-9521`) are unchanged. This transport ADDS a reader; it
 * replaces nothing.
 *
 * @param isProductionRuntime the connector's own hosting-mode signal
 *        (`./web-connector.ts:122`) — passed in rather than re-derived so there
 *        is one definition of "this process is Vite-hosted", not two.
 */
export function devErrorTransportPlugin(options: {
  isProductionRuntime: () => boolean;
  buildErrorMessage: BuildErrorMessage;
}): Plugin {
  const { isProductionRuntime, buildErrorMessage } = options;

  if (isProductionRuntime()) {
    throw new DevErrorTransportInProductionError();
  }

  const capture: Connect.ErrorHandleFunction = (error, request, _response, next) => {
    // Re-asserted per request, not just at construction: `runtimeStrategy` is
    // process state and a transport that leaks source frames is not something
    // to hold open on a boot-time reading alone. In production this layer is a
    // pass-through and vite's handler behaves exactly as it does today.
    if (isProductionRuntime()) return next(error);

    (request as DevTransformErrorCarrier)[DEV_TRANSFORM_ERROR_BODY] = formatDevTransformError(
      error,
      buildErrorMessage,
    );

    next(error);
  };

  return {
    name: "warlock:dev-error-transport",
    // Belt to the `isProductionRuntime` braces: this plugin has no business in
    // a `vite build` graph either.
    apply: "serve",
    configureServer(server) {
      // RETURNING a function is what makes this a POST hook — the ordering the
      // note above depends on. Mounting inline here would land the layer BEFORE
      // vite's transform middleware, where no error has been thrown yet.
      return () => {
        server.middlewares.use(capture);
      };
    },
  };
}

/**
 * Answer the request with the failure {@link devErrorTransportPlugin} captured,
 * if there was one. Returns `false` when there was not, which is the normal
 * case and means "carry on down the framework's own path".
 *
 * Called from the Fastify `onRequest` hook that mounts vite
 * (`./web-connector.ts:321`), in the `done` callback — i.e. at the one moment
 * where connect has finished, vite has declined to answer, and the framework is
 * about to 404. Writing to the raw `ServerResponse` rather than through Fastify
 * is what the mount already does for every response vite serves, so this stays
 * on the same side of the seam.
 */
export function sendCapturedDevError(request: IncomingMessage, response: ServerResponse): boolean {
  const body = (request as DevTransformErrorCarrier)[DEV_TRANSFORM_ERROR_BODY];

  if (typeof body !== "string") return false;

  // A middleware further down may have answered already (vite serves plenty of
  // requests itself). Never write twice; the captured body is then just dropped.
  if (response.headersSent || response.writableEnded) return false;

  response.statusCode = DEV_TRANSFORM_ERROR_STATUS;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  // A refusal is a fact about the CURRENT source. Caching it would survive the
  // edit that fixes it.
  response.setHeader("cache-control", "no-store");
  response.end(body);

  return true;
}
