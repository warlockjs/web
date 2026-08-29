/**
 * THE NOT-FOUND PATH — the one route in the application that answers for URLs
 * nobody declared.
 *
 * An application gets it by writing `404.page.tsx` anywhere under a web root.
 * The file is named for the status it answers with, not for a concept
 * ("not-found"), because `404` is the string people actually search for, and
 * the `*.page.tsx` suffix is what makes it a page in the first place.
 *
 * ── THE RULE THIS FILE EXISTS FOR ────────────────────────────────────────────
 *
 * Pages and API routes share ONE route namespace and ONE router. So a catch-all
 * page route sees every unmatched request in the process, including
 * `GET /api/uzers` — and if it renders a document for that, a `fetch()` gets
 * `<!doctype html>` back and dies inside `response.json()` with a SyntaxError
 * pointing at the parser instead of at the typo. That failure is expensive
 * precisely because the error names nothing near its cause.
 *
 * Because pages and API share one namespace there is no path-prefix rule
 * available: `/anything` may legitimately be either. The discriminator is
 * therefore the `Accept` header, and it is stated as a narrow permission rather
 * than a guess — the document is the exception, JSON is the default:
 *
 *   A request renders the not-found PAGE only if
 *     1. its method is GET or HEAD, and
 *     2. `text/html` appears EXPLICITLY in its `Accept` header.
 *
 *   (1) is not a heuristic about browsers. Pages are registered with
 *       `router.get` and nothing else — every page route in this codebase is
 *       installed by `installPageRoutes` / `installPageRoutesFromManifest`, both
 *       of which call `router.get`. A `POST` therefore cannot have been meant
 *       for a page, by construction. HEAD rides along because Fastify answers it
 *       from the GET route.
 *
 *   (2) is EXPLICIT and the word is load-bearing. A wildcard does NOT count:
 *       `* /*` — what a bare `fetch()` sends — is not a request for a document,
 *       it is the absence of a preference, and `text/*` claims a family rather
 *       than the type. Only the literal `text/html` media range, with a non-zero
 *       `q`, opens the page path. A browser address-bar navigation always sends
 *       an explicit `text/html`; a `fetch()` that has not asked for one never
 *       does. So the mistyped `/api/...` in a `fetch()` keeps its JSON body and
 *       dies at the typo rather than inside `response.json()`.
 *
 * WHAT THE RULE CANNOT DECIDE, and does not pretend to: a browser navigating to
 * a typo'd API URL asks for `text/html`, and so is answered with the document.
 * Nothing in that request distinguishes it from a typo'd page URL — same verb,
 * same header, same absence of a match — so the rule does not guess. The status
 * is 404 either way, which is the part machines read.
 *
 * ── DEPENDENCY NOTE ──────────────────────────────────────────────────────────
 * This module has NO runtime imports. `../build/discover-pages` imports the
 * filename constant and the identity helpers from here so build discovery and
 * both installers cannot disagree about what a not-found page is, and that edge
 * must not drag the render pipeline into the build.
 */
import type { HttpContext } from "@warlock.js/core";
import type { PageRouteHandler } from "./create-page-route-handler";

/**
 * The one filename that makes a page THE not-found page.
 *
 * `404.page.tsx`, not `not-found.page.tsx`: it keeps the `*.page.tsx`
 * convention every other page follows, and `404` is the token a developer
 * greps for when a URL answers with one.
 */
export const NOT_FOUND_PAGE_FILENAME = "404.page.tsx";

/**
 * The path the not-found route is registered on — find-my-way's and Fastify's
 * catch-all, and the same literal core's own dev dispatcher registers
 * (`core/src/router/router.ts`, `server.route({ url: "*" })`).
 *
 * A catch-all has the LOWEST matching priority in both routers, so every
 * declared page and every declared API route still wins on its own path; this
 * route is only ever reached because nothing else claimed the URL.
 */
export const NOT_FOUND_ROUTE_PATH = "*";

/**
 * The reserved route name the not-found page is registered under.
 *
 * Namespaced under `warlock.` because it is the framework's route rather than
 * the application's, and because the router's name namespace is shared with API
 * routes — an application that takes this name gets core's duplicate-name error,
 * which is the loud answer, not a silent overwrite.
 *
 * It is deliberately NOT published into the route table (`href()` / `<Link>`):
 * the not-found page has no URL of its own to link to.
 */
export const NOT_FOUND_ROUTE_NAME = "warlock.not-found";

/** True when `sourceFile`'s basename is exactly {@link NOT_FOUND_PAGE_FILENAME}. */
export function isNotFoundPageFile(sourceFile: string): boolean {
  const separator = Math.max(sourceFile.lastIndexOf("/"), sourceFile.lastIndexOf("\\"));

  return sourceFile.slice(separator + 1) === NOT_FOUND_PAGE_FILENAME;
}

/**
 * Raised when more than one `404.page.tsx` exists.
 *
 * There is exactly one not-found route in a process, so a second file is not a
 * per-module override — it is two files claiming one route, with the winner
 * decided by directory-walk order. Both are named because the fix is to delete
 * one and the operator has to know which two are in play.
 */
export class DuplicateNotFoundPageError extends Error {
  public constructor(public readonly pageFiles: readonly string[]) {
    super(
      `Two or more not-found pages were found: ${pageFiles.map((file) => `"${file}"`).join(", ")}. ` +
        `An application has exactly one \`${NOT_FOUND_PAGE_FILENAME}\` — it answers every ` +
        "unmatched page URL in the process, so a second one would silently never render. " +
        "Keep one and delete the rest.",
    );
    this.name = "DuplicateNotFoundPageError";
  }
}

/**
 * Raised when `404.page.tsx` declares a `route` export.
 *
 * The not-found page has no URL of its own — it is reached by NOT matching. A
 * `route` export on it reads like a promise that `/404` is browsable, and it is
 * not: the installers register this file on the catch-all and nowhere else. So
 * the export is refused rather than ignored, because a declaration the framework
 * silently drops is worse than one it rejects.
 */
export class NotFoundPageDeclaresRouteError extends Error {
  public constructor(public readonly pageFile: string) {
    super(
      `"${pageFile}" is the not-found page but declares a \`route\` export. ` +
        `\`${NOT_FOUND_PAGE_FILENAME}\` has no URL of its own — it answers every page URL that ` +
        "matched nothing, and is never registered at a path of its own. Remove the `route` " +
        "export; to serve a browsable page at a fixed path, use a normal `*.page.tsx`.",
    );
    this.name = "NotFoundPageDeclaresRouteError";
  }
}

/** The shape this module reads off a registered route — core's `Route`, narrowed. */
export type RegisteredRouteShape = {
  path: string;
  isPage?: boolean;
};

/**
 * The media range the not-found PAGE is gated on. Compared literally: a request
 * either named this exact type or it did not.
 */
const HTML_MEDIA_TYPE = "text/html";

/**
 * True when `text/html` is named EXPLICITLY in an `Accept` header — the whole
 * discriminator, in one predicate.
 *
 * Wildcards are refused on purpose. `* /*` is what `fetch()` and `curl` send
 * when the caller expressed no preference at all, and `text/*` names a family;
 * neither is a request for a document, and treating either as one is what makes
 * a mistyped `/api/...` answer HTML to a JSON parser.
 *
 * `q=0` is honoured because it is the header's own way of saying "not this
 * one" — `Accept: text/html;q=0, application/json` is a client refusing the
 * document, and reading it as a request for one would be reading the header
 * backwards. Any other `q`, present or absent, counts.
 */
export function acceptsHtmlExplicitly(accept: string | undefined): boolean {
  if (!accept) return false;

  for (const entry of accept.split(",")) {
    const [rawType, ...parameters] = entry.split(";");

    if (rawType.trim().toLowerCase() !== HTML_MEDIA_TYPE) continue;

    const quality = parameters
      .map((parameter) => parameter.trim().toLowerCase())
      .find((parameter) => parameter.startsWith("q="));

    // A malformed `q` is not a refusal — only an explicit zero is.
    if (quality !== undefined && Number.parseFloat(quality.slice(2)) === 0) continue;

    return true;
  }

  return false;
}

export type UnmatchedRequestKind = "page" | "api";

/**
 * The rule, in one function — see this file's header for why it is these two
 * conditions and why the second one refuses wildcards.
 */
export function classifyUnmatchedRequest(input: {
  method: string;
  accept: string | undefined;
}): UnmatchedRequestKind {
  const method = input.method.toUpperCase();

  // Pages are installed with `router.get`, so only these two verbs can ever
  // have been asking for one.
  if (method !== "GET" && method !== "HEAD") return "api";

  return acceptsHtmlExplicitly(input.accept) ? "page" : "api";
}

/**
 * The document served when the application ships no `404.page.tsx`.
 *
 * Deliberately a STRING, not a React render: it must survive the case where the
 * application root, a layout or the page module is exactly what is broken, and
 * a default that can itself fail is not a default. It carries no stylesheet and
 * no hydration script for the same reason — nothing here can 500.
 *
 * It answers 404 like the real page does, because the status is the part that
 * search engines, caches and monitoring read; a framework default that soft-404s
 * would teach every un-customised application to lie.
 */
export function frameworkDefaultNotFoundDocument(): string {
  return (
    "<!doctype html>" +
    '<html lang="en">' +
    "<head>" +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    "<title>404 — Page not found</title>" +
    "</head>" +
    "<body>" +
    "<h1>404 — Page not found</h1>" +
    "<p>This URL does not match any page.</p>" +
    `<p>To replace this page, add <code>${NOT_FOUND_PAGE_FILENAME}</code> to a web folder ` +
    "(for example <code>src/web/404.page.tsx</code>).</p>" +
    "</body>" +
    "</html>"
  );
}

export type NotFoundRouteHandlerOptions = {
  /**
   * The application's `404.page.tsx`, already built into a page handler by
   * whichever installer owns module loading — `undefined` when the application
   * ships no such file, which is what selects
   * {@link frameworkDefaultNotFoundDocument}.
   *
   * Taking a built handler rather than a module keeps this file out of the
   * render pipeline entirely: dev hands over a Vite-backed handler, production a
   * manifest-backed one, and neither difference is visible here.
   */
  renderPage?: PageRouteHandler;
};

/**
 * The handler registered on the catch-all.
 *
 * Three answers, in this order, and the order is the safety property: the API
 * check runs BEFORE anything can render, so no request that the rule calls an
 * API request can reach a React render even if the page module is broken.
 */
export function createNotFoundRouteHandler(
  options: NotFoundRouteHandlerOptions,
): PageRouteHandler {
  const { renderPage } = options;

  return async (context: HttpContext) => {
    const { request, response } = context;
    // Node lowercases header names and collapses a repeated `Accept` into an
    // array; both forms are read, so a duplicated header cannot silently mean
    // "no preference".
    const accept = request.header("accept");

    if (
      classifyUnmatchedRequest({
        method: request.method,
        accept: Array.isArray(accept) ? accept.join(",") : accept,
      }) === "api"
    ) {
      // The same body core's own dev dispatcher writes for an unmatched route
      // (`core/src/router/router.ts`), so an API 404 reads identically whether
      // it fell through to core or was declined here — and identically in
      // development and in production, which it previously was not.
      await response.send(
        { error: "Route not found", path: request.path, method: request.method },
        404,
      );

      return;
    }

    if (renderPage === undefined) {
      await response.html(frameworkDefaultNotFoundDocument(), 404);

      return;
    }

    return renderPage(context);
  };
}
