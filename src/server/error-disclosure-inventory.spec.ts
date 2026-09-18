/**
 * REPO-WIDE INVENTORY — every path in `web` where a thrown value's own
 * `.message`/`.stack` can reach the browser, and whether it is sanitized.
 *
 * Card c52d5653. Searched with `rg --no-ignore` across `web/src` for
 * `.message`, `.stack`, `error:` payload-builder literals, `buildHydrationPayload`,
 * NDJSON/defer line writers, redirect/404 payload builders, navigation
 * data-response error shapes, and dev-overlay code that might ship in prod.
 *
 * THE TWO CHOKEPOINTS every browser-bound error must cross:
 *   - `serializePageError` (`./error-page.ts:38`) — the hydration-payload /
 *     `error.page.tsx` PROPS-FOR-HYDRATION sanitizer. In production, only a
 *     `PublicPageError` keeps its own `message`; everything else becomes the
 *     generic message + an opaque `errorCode`. `stack` never crosses, ever.
 *   - `buildErrorRecord` (`./settle-page-response.ts:30`) — the
 *     loader/middleware-throw boundary's OWN enforcement of the identical
 *     rule, one stage earlier (it is what feeds `bundle.error` into the
 *     render loop that eventually calls `serializePageError` again via
 *     `hydrationErrorPageProps`).
 *
 * ┌────┬───────────────────────────────────────────────────────────┬──────────────┬─────────────────────────────────────────────────────────────────┐
 * │ #  │ Path (file:line)                                            │ Sanitized?   │ How                                                                 │
 * ├────┼───────────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────┤
 * │ 1  │ error-page.ts:38-70 `serializePageError`                     │ YES (IS the  │ THE hydration-payload chokepoint itself. Production: only          │
 * │    │                                                               │ chokepoint)  │ `PublicPageError` keeps `.message`; else generic message +        │
 * │    │                                                               │              │ `errorCode`; `.stack` never crosses. Covered: error-page.spec.ts. │
 * ├────┼───────────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────┤
 * │ 2  │ settle-page-response.ts:30-66 `buildErrorRecord`             │ YES (IS the  │ Loader/middleware-throw boundary chokepoint. Production: replaces │
 * │    │                                                               │ chokepoint)  │ non-`PublicPageError` with a generic surrogate `Error`, keeps the │
 * │    │                                                               │              │ real value only on `originalError` (server-side use — see #7).    │
 * │    │                                                               │              │ Covered: settle-page-response.spec.ts.                            │
 * ├────┼───────────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────┤
 * │ 3  │ execute-page-request.ts:182,234,397,451 — every              │ YES          │ All four call sites route the thrown/short-circuit value through  │
 * │    │ `buildErrorRecord(...)` call site                            │              │ #2 before it ever reaches `bundle.error`. New test below.         │
 * ├────┼───────────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────┤
 * │ 4  │ render-page.ts:731 reconstructed `Error` from a rejected     │ YES (double) │ `failure.error` is already the SANITIZED wire settlement (built    │
 * │    │ deferred settlement, awaited-and-inlined path                │              │ by #6/toSettlementError); the reconstruction is re-thrown straight │
 * │    │                                                               │              │ into #2 (line 738) — sanitized twice, never the raw value.         │
 * ├────┼───────────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────┤
 * │ 5  │ render-page.ts:869,1076 `hydrationErrorPageProps(props,      │ YES          │ Both call sites feed `serializableError`/`undefined` (never the    │
 * │    │ serializableError, requestId)` → `bundle.errorPage`          │              │ raw `thrown`) into #1. New tests below (build-hydration-payload,   │
 * │    │                                                               │              │ write-page-failure-response).                                     │
 * ├────┼───────────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────┤
 * │ 6  │ build-hydration-payload.ts:95 `...{ errorPage:               │ YES          │ Only ever carries the ALREADY-sanitized `bundle.errorPage` from    │
 * │    │ bundle.errorPage }` — the `#__WARLOCK_DATA__` / `_loader`     │              │ #5 — this file never re-derives an error shape itself. New test.  │
 * │    │ JSON payload's own error field                               │              │                                                                     │
 * ├────┼───────────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────┤
 * │ 7  │ render-page.ts:278-297,~885,~1098 `errorPageElement`/         │ YES          │ `resolveServerErrorPageProps` (render-page.ts) is now the ONLY     │
 * │    │ `resolveServerErrorPageProps` — the ACTUAL REACT PROPS        │              │ thing that ever reaches `errorPageElement`/`renderPageFailure`'s  │
 * │    │ handed to the application's `error.page.tsx` /                │              │ fallback element for the SSR RENDER. In production it returns      │
 * │    │ `renderPageFailure`'s fallback element, for the SSR RENDER    │              │ `errorPage.error` — the SAME sanitized `SerializedPageError`       │
 * │    │ (not the JSON payload)                                       │              │ object `hydrationErrorPageProps` (#5) already built for the        │
 * │    │                                                               │              │ hydration payload, never the raw `thrown` — so SSR and hydration   │
 * │    │                                                               │              │ can no longer disagree. Development is unchanged: the raw error,   │
 * │    │                                                               │              │ same as before. Fixed under card c52d5653. Covered:                │
 * │    │                                                               │              │ render-page.spec.ts ("resolveServerErrorPageProps — SSR/hydration │
 * │    │                                                               │              │ parity"); `skills/create-a-page/SKILL.md` updated to match.        │
 * ├────┼───────────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────┤
 * │ 8  │ defer-settlement.ts:38-46 `toSettlementError`                │ YES          │ Every deferred rejection/timeout goes through #1 before becoming  │
 * │    │ (`createDeferredSettlement`'s wire-shape settlement)          │              │ `DeferSettlement.error`. Covered: defer-settlement.spec.ts         │
 * │    │                                                               │              │ (includes its own red control).                                   │
 * ├────┼───────────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────┤
 * │ 9  │ write-deferred-ndjson-response.ts:96 (line-1 payload, via    │ YES          │ Line 1 is `buildHydrationPayload` (#6); each settlement line      │
 * │    │ #6) and :130 (in-band serialize-failure catch)               │              │ replays the already-sanitized `settlements[key]` (#8), and the    │
 * │    │                                                               │              │ catch branch (a devalue failure, never the app's own error) also  │
 * │    │                                                               │              │ calls #1 directly. New test below.                                │
 * ├────┼───────────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────┤
 * │ 10 │ defer-emission.ts:219 in-band serialize-failure catch,        │ YES          │ Same shape as #9 for the document's post-shell `<script>` chunks. │
 * │    │ document post-shell chunk writer                             │              │ New test below.                                                    │
 * ├────┼───────────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────┤
 * │ 11 │ page-route-handler/write-page-failure-response.ts:52-89       │ YES          │ Escaped-the-pipeline failures (module load/register throw) go      │
 * │    │ (module-load-escape path, both document and data reps)        │              │ through `renderPageFailure` (#5/#7's non-SSR half) for both the   │
 * │    │                                                               │              │ HTML body and the `stringify(buildHydrationPayload(...))` JSON    │
 * │    │                                                               │              │ body. New test below — also re-confirms finding #7 on this path.  │
 * ├────┼───────────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────┤
 * │ 12 │ page-middleware-short-circuit-error.ts, page-validation-      │ YES          │ Both classes' `super(...)` messages are FIXED, static strings —   │
 * │    │ failed-error.ts — `PageMiddlewareShortCircuitError`,          │              │ never interpolate a thrown value's own text — and both are fed    │
 * │    │ `PageValidationFailedError`                                  │              │ through #2/#3 regardless. `errors`/`payload` fields (app-supplied │
 * │    │                                                               │              │ validation issues / middleware return value) are a documented,    │
 * │    │                                                               │              │ intentional channel (see `bundle.shortCircuit`), not a thrown      │
 * │    │                                                               │              │ Error's message/stack — out of this inventory's scope.            │
 * ├────┼───────────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────┤
 * │ 13 │ dev-error-transport.ts (`formatDevTransformError`,            │ N/A — DEV    │ Construction throws `DevErrorTransportInProductionError` when     │
 * │    │ `sendCapturedDevError`) — Vite transform-failure overlay      │ ONLY, never  │ `isProductionRuntime()` is true, re-checked per request too.       │
 * │    │                                                               │ reachable in │ Covered: dev-error-transport.spec.ts ("refuses to be constructed  │
 * │    │                                                               │ production   │ at all on a production-hosted process", "is inert...").           │
 * ├────┼───────────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────┤
 * │ 14 │ install-page-routes.ts `PageModuleLoadError` (dev page-       │ N/A — DEV/   │ File header: "dev/CLI bootstrap only", not part of                 │
 * │    │ module-load failure route)                                    │ CLI ONLY     │ `web/package.json`'s dependency graph. Production installs        │
 * │    │                                                               │              │ exclusively through `install-production-page-routes.ts` →         │
 * │    │                                                               │              │ `installPageRoutesFromManifest`, which never imports this file.   │
 * │    │                                                               │              │ New test below asserts that import boundary statically.           │
 * ├────┼───────────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────┤
 * │ 15 │ not-found-page.ts (`createNotFoundRouteHandler`)              │ YES —        │ Every body is a fixed literal (`{ error: "Route not found", ... }`│
 * │    │                                                               │ no error text│ or the static framework 404 document); no thrown value's own text │
 * │    │                                                               │ at all       │ is ever interpolated.                                              │
 * ├────┼───────────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────┤
 * │ 16 │ page-cache-eligibility.ts `isStoreEligible`                   │ N/A — cache  │ Storage requires `status === 200`; an error response (4xx/5xx) is │
 * │    │                                                               │ never stores │ never store-eligible, so a scrubbed-then-later-served-stale error  │
 * │    │                                                               │ an error page│ response is not a channel here.                                    │
 * ├────┼───────────────────────────────────────────────────────────┼──────────────┼─────────────────────────────────────────────────────────────────┤
 * │ 17 │ report-server-error.ts, install-page-routes.ts's own          │ N/A — never  │ Plain `console.error(...)`. `stderr` is an operator surface, never │
 * │    │ `console.error` lines, render-page.ts's `reportRenderError`/  │ browser-bound│ part of any HTTP response body.                                    │
 * │    │ `reportErrorPageFailure`                                     │              │                                                                     │
 * │    │ hydration-payload.ts `malformedPayload`/`readHydrationPayload`│ N/A —        │ CLIENT code parsing what the server already sent; not a leak       │
 * │    │                                                               │ client-side  │ source itself, and its own thrown messages are fixed literals.     │
 * └────┴───────────────────────────────────────────────────────────┴──────────────┴─────────────────────────────────────────────────────────────────┘
 *
 * ── FINDING (row #7) — FIXED under card c52d5653 ────────────────────────────
 * Every OTHER path in this table funnels through `serializePageError` /
 * `buildErrorRecord` before a thrown value's `.message` can reach anything
 * browser-bound. Row #7 used to be the one path that did not:
 * `render-page.ts` unconditionally set `ServerErrorPageProps.error` to the
 * RAW thrown value and handed it straight to the application's
 * `error.page.tsx` default export as React props, which was then rendered to
 * the HTML string that IS the document response — with no environment
 * branch at all, so an `error.page.tsx` that printed `error.message` put an
 * unexpected production error's real message in front of a real visitor, on
 * every full-document error response, regardless of environment.
 *
 * Fixed in `render-page.ts` via `resolveServerErrorPageProps`: in production
 * it hands SSR the SAME sanitized `SerializedPageError` the hydration
 * payload already carries (row #5/#6), instead of the raw thrown value —
 * SSR and hydration can no longer disagree, and only a `PublicPageError`'s
 * own message still reaches a real visitor. Development is unchanged: the
 * raw error, same as before. `skills/create-a-page/SKILL.md` updated to
 * match. See `render-page.spec.ts`'s "resolveServerErrorPageProps — SSR/
 * hydration parity" describe for the fix's own coverage (including its red
 * control) — not duplicated here; see the TEST-HARNESS NOTE below for why.
 *
 * ── TEST-HARNESS NOTE ────────────────────────────────────────────────────────
 * `setEnvironment("production")` cannot be combined with an actual
 * `renderToString()` call in this suite: Vite's test-mode JSX transform
 * emits `react/jsx-dev-runtime` calls unconditionally (independent of
 * `NODE_ENV`), which is incompatible with react-dom-server's PRODUCTION
 * build (`TypeError: dispatcher.getOwner is not a function`) — this is
 * structural to the transform, not an import-order artifact, so no ordering
 * trick fixes it. No existing spec in this file's neighborhood exercises a
 * real SSR render under simulated production for exactly this reason (see
 * `render-page.spec.ts`, `create-page-route-handler.spec.ts`: neither ever
 * calls `setEnvironment` alongside `renderPageRequest`/`renderPageFailure`).
 * This is also why row #7's OWN production coverage (`render-page.spec.ts`)
 * tests `resolveServerErrorPageProps` directly — the pipeline stage that
 * decides SSR's props.error — rather than asserting on real production HTML.
 * Every OTHER row's test below still asserts the real production branch via
 * `setEnvironment("production")`, since those paths' sanitization IS
 * environment-gated and never touch a real SSR render to prove.
 */
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "devalue";
import { Response, setEnvironment, type Request } from "@warlock.js/core";
import { PAYLOAD_SCRIPT_ID } from "../components/document-context";
import { createCoreHttp } from "./__fixtures__/core-http";
import { buildHydrationPayload } from "./build-hydration-payload";
import { wrapPipeableStreamForDeferredEmission } from "./defer-emission";
import { createDeferredSettlement } from "./defer-settlement";
import type { ErrorPageModule } from "./error-page";
import { hydrationErrorPageProps, serializePageError } from "./error-page";
import { buildErrorRecord, designateBoundary } from "./settle-page-response";
import type {
  PageBoundaryDesignation,
  PageDataBundle,
  PageRouteEntry,
} from "./execute-page-request";
import { connectPageContext, executePageRequest } from "./execute-page-request";
import { PublicPageError } from "./public-page-error";
import { renderPageFailure, renderPageRequest } from "./render-page";
import type { ServerErrorPageProps } from "../props";
import { writeDeferredNdjsonResponse } from "./write-deferred-ndjson-response";
import { writePageFailureResponse } from "./page-route-handler/write-page-failure-response";

const SECRET = "secret-xyz";
const originalNodeEnv = process.env.NODE_ENV;

function restoreEnvironment(): void {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
}

connectPageContext({
  buildStore: (payload) => payload as never,
  getStore: () => undefined,
  run: async (_store, callback) => callback(),
});

function bundleOf(overrides: Partial<PageDataBundle> = {}): PageDataBundle {
  return {
    route: { name: "dashboard", path: "/dashboard", params: {}, query: {} },
    appData: {},
    layoutData: {},
    pageData: {},
    shared: {} as PageDataBundle["shared"],
    ...overrides,
  };
}

describe("error disclosure inventory — production sanitization, per path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnvironment();
  });

  // Row #1 — the chokepoint. Own coverage here for completeness; the
  // exhaustive branch matrix already lives in error-page.spec.ts.
  it("path 1 — serializePageError never exposes an unexpected error's own message in production", () => {
    setEnvironment("production");

    const serialized = serializePageError(new Error(SECRET));

    expect(serialized.message).not.toContain(SECRET);
    expect(serialized).not.toHaveProperty("stack");
  });

  // Row #2 — the loader/middleware-throw boundary chokepoint. Own coverage
  // here for completeness; full matrix in settle-page-response.spec.ts.
  it("path 2 — buildErrorRecord scrubs an unexpected loader/middleware error's message in production", () => {
    setEnvironment("production");
    const boundary: PageBoundaryDesignation = designateBoundary("page", {
      app: {},
      layout: {},
      page: {},
    });

    const record = buildErrorRecord(new Error(SECRET), boundary, "/orders/42");

    expect((record.error as Error).message).not.toContain(SECRET);
    expect((record.error as Error).message).toBe("An unexpected error occurred.");
  });

  // Row #3 — every buildErrorRecord call site inside execute-page-request.ts
  // (middleware throw, validation failure, loader throw, awaited-deferred
  // rejection) all produce bundle.error via #2. Exercised through the REAL
  // pipeline (`executePageRequest`, not `renderPageRequest`) — deliberately
  // stops short of `render-page.ts`'s `renderToString`: this test file also
  // needs a real, unpoisoned SSR render for the row #7 RED CONTROL below, and
  // `renderToString` cannot be combined with `setEnvironment("production")`
  // in this suite (see the TEST-HARNESS NOTE above).
  it("path 3 — a page loader throw's bundle.error carries the scrubbed message in production", async () => {
    setEnvironment("production");
    const entry: PageRouteEntry = {
      path: "/boom",
      name: "boom",
      triple: {
        app: {},
        layout: {},
        page: {
          loader: () => {
            throw new Error(SECRET);
          },
        },
      },
    };

    const request = { setValidatedData: () => undefined } as unknown as Request;
    const response = new Response();

    const bundle = await executePageRequest({
      url: "/boom",
      routes: [entry],
      createHttp: () => ({ request, response }),
    });

    if (bundle instanceof Response || bundle === undefined) {
      throw new Error("unexpected terminal result");
    }

    expect((bundle.error?.error as Error).message).not.toContain(SECRET);
    expect((bundle.error?.error as Error).message).toBe("An unexpected error occurred.");
    expect(bundle.error?.scrubbed).toBe(true);
  });

  // Row #5/#6 — hydrationErrorPageProps feeds only the sanitized value into
  // bundle.errorPage, and buildHydrationPayload only ever spreads that
  // already-sanitized value onto the wire payload.
  it("path 5/6 — the hydration payload's own errorPage field is sanitized in production even when the raw error is available", () => {
    setEnvironment("production");
    const thrown = new Error(SECRET);
    const errorPage = hydrationErrorPageProps({ error: thrown, status: 500 }, thrown, "req-1");
    const bundle = bundleOf({ errorPage });

    const wire = stringify(buildHydrationPayload(bundle, "en"));

    expect(wire).not.toContain(SECRET);
    expect(errorPage.error.message).toBe("An unexpected error occurred.");
  });

  // Row #9 — write-deferred-ndjson-response.ts. Uses the REAL
  // createDeferredSettlement (row #8's own sanitizer) feeding a genuine
  // production rejection all the way onto the NDJSON wire.
  it("path 9 — a rejected deferred value's own message never reaches the NDJSON wire in production", async () => {
    setEnvironment("production");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const pair = createDeferredSettlement("reviews", Promise.reject(new Error(SECRET)), 1_000);
    pair.componentPromise.catch(() => undefined);

    const bundle = bundleOf({
      pageData: { reviews: pair.componentPromise },
      deferredKeys: ["reviews"],
      deferredSettlements: { reviews: pair.settlement },
    });

    const http = createCoreHttp({ url: "/dashboard" });
    const chunks: Buffer[] = [];
    http.reply.raw.on("data", (chunk: Buffer) => chunks.push(chunk));

    await writeDeferredNdjsonResponse(http.response, bundle, "en", 200);

    const wire = Buffer.concat(chunks).toString("utf8");
    expect(wire).not.toContain(SECRET);
  });

  // Row #10 — defer-emission.ts's document post-shell chunk writer. Same
  // real-sanitizer-to-wire proof, for the document (non-NDJSON) path.
  it("path 10 — a rejected deferred value's own message never reaches the document's post-shell chunk in production", async () => {
    setEnvironment("production");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const pair = createDeferredSettlement("reviews", Promise.reject(new Error(SECRET)), 1_000);
    pair.componentPromise.catch(() => undefined);

    const fakeShell: { pipe<W extends NodeJS.WritableStream>(destination: W): W } = {
      pipe(destination) {
        destination.write("<html>shell</html>");
        destination.end();
        return destination;
      },
    };

    const wrapped = wrapPipeableStreamForDeferredEmission({
      pipeableStream: fakeShell as never,
      deferred: [{ key: "reviews", settlement: pair.settlement }],
      nonce: undefined,
      allReady: Promise.resolve(),
      routeName: "dashboard",
    });

    const destination = new PassThrough();
    const chunks: Buffer[] = [];
    destination.on("data", (chunk: Buffer) => chunks.push(chunk));
    const ended = new Promise<void>((resolve) => destination.once("finish", () => resolve()));

    wrapped.pipe(destination);
    await ended;

    const wire = Buffer.concat(chunks).toString("utf8");
    expect(wire).not.toContain(SECRET);
  });

  // Row #11 — write-page-failure-response.ts, the module-load-escape path,
  // BOTH representations. NOT run under `setEnvironment("production")`: both
  // representations go through a real `renderPageFailure` → `renderToString`
  // call (see the TEST-HARNESS NOTE above for why that combination cannot be
  // used in this suite). Production scrubbing for `bundle.errorPage` itself
  // is already independently proven by path 1 (`serializePageError`) and
  // path 5/6 — this test instead proves the WIRING: both representations
  // read `bundle.errorPage`/the hydration payload, never `thrown` directly,
  // so whatever `hydrationErrorPageProps` produces (sanitized, in
  // production) is what actually reaches the wire, on both reps.
  it("path 11 — both representations carry the pipeline's own errorPage field, never a raw interpolation of `thrown`", async () => {
    const errorPageModule: ErrorPageModule = {
      default: (props: ServerErrorPageProps) => createElement("p", {}, `Status: ${props.status}`),
    };
    const request = { nonce: undefined, locale: "en" } as unknown as Request;

    // `renderPageFailure`'s document is a non-hydrating fallback (see
    // "renderPageFailure — pre-triple fallback" in render-page.spec.ts) with
    // no embedded payload script, so `.bundle.errorPage` — what BOTH
    // representations ultimately read — is checked directly here rather than
    // scraped back out of HTML.
    const rendered = await renderPageFailure({
      name: "boom",
      path: "/boom",
      request,
      response: new Response(),
      thrown: new Error(SECRET),
      loadErrorPage: async () => errorPageModule,
    });

    // Not `.toContain(SECRET)`: dev-mode `serializePageError` legitimately
    // keeps the message (see path 1) — the proof here is structural, that
    // `bundle.errorPage` is the SANITIZER's `{ name, message, stack? }` shape,
    // built by `hydrationErrorPageProps`/`serializePageError` (never a raw
    // `${thrown}` string interpolation).
    expect(rendered.bundle?.errorPage?.error).toEqual({
      name: "Error",
      message: SECRET,
      stack: expect.any(String),
    });

    const dataHttp = createCoreHttp({ url: "/boom", headers: { accept: "application/json" } });

    await writePageFailureResponse({
      name: "boom",
      request: dataHttp.request,
      response: dataHttp.response,
      thrown: new Error(SECRET),
      loadErrorPage: async () => errorPageModule,
      wantsData: true,
      applyBufferedCookie: () => undefined,
    });

    const body = String(dataHttp.reply.payloads[0]);
    expect(parse(body)).toMatchObject({ errorPage: { error: { message: SECRET } } });
  });

  // Row #13 — dev-error-transport.ts is unreachable in production; own
  // coverage lives in dev-error-transport.spec.ts. Asserted here structurally
  // so this inventory doesn't just take that file's word for it.
  it("path 13 — the dev transform-error transport refuses to exist on a production-hosted process", async () => {
    const { devErrorTransportPlugin } = await import("./dev-error-transport");

    expect(() =>
      devErrorTransportPlugin({
        isProductionRuntime: () => true,
        buildErrorMessage: (error) => error.message,
      }),
    ).toThrow(/must never be mounted on a production-hosted server/);
  });

  // Row #14 — install-page-routes.ts (dev/CLI-only page-module-load-failure
  // route) must never be part of the production install's import graph.
  it("path 14 — production page install never imports the dev-only failed-page-route installer", async () => {
    const source = await readFile(
      new URL("./install-production-page-routes.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/from ["']\.\/install-page-routes["']/);
  });
});

/**
 * ── DEV-MODE BEHAVIOR (row #7, fixed) ────────────────────────────────────────
 * Development keeps the raw error, unchanged by the c52d5653 fix: a plain,
 * plausible-to-write `error.page.tsx` that renders `(error as Error).message`
 * still puts the error's own text straight into the response HTML when
 * running outside production — intentional, so app authors can debug locally
 * with the real error. The production branch (no longer reachable the same
 * way — `resolveServerErrorPageProps` now sits between the throw and SSR
 * `props.error`, same as it already sat between the throw and the hydration
 * payload) is covered directly in `render-page.spec.ts`, not here — see the
 * TEST-HARNESS NOTE above.
 */
describe("dev-mode error.page.tsx still receives the raw thrown value (row #7, unchanged)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnvironment();
  });

  it("in dev mode, an error.page.tsx that reads error.message puts the real message in the response body; the payload's errorPage field does not", async () => {
    const entry: PageRouteEntry = {
      path: "/boom",
      name: "boom",
      triple: {
        app: {},
        layout: {},
        page: {
          default: () => {
            throw new Error(SECRET);
          },
        },
      },
    };

    const response = new Response();
    const request = { nonce: undefined, locale: "en" } as unknown as Request;
    // A plausible, undocumented-as-forbidden error.page.tsx: nothing about
    // its shape signals danger, and skills/create-a-page/SKILL.md's own
    // example differs from this only by which field it reads.
    const rawErrorPageModule: ErrorPageModule = {
      default: (props: ServerErrorPageProps) =>
        createElement(
          "span",
          {},
          props.error instanceof Error ? props.error.message : "no message",
        ),
    };

    const rendered = await renderPageRequest("/boom", {
      routes: [entry],
      createHttp: () => ({ request, response }),
      loadErrorPage: async () => rawErrorPageModule,
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    // Dev mode, unchanged: the component's own rendered output still carries
    // the raw message.
    expect(rendered.html).toContain(SECRET);

    // THE CONTRAST: the SAME response's hydration payload — the channel
    // `serializePageError`/`hydrationErrorPageProps` actually guard — stays
    // on the sanitized shape (message/stack survive here only because this
    // suite runs outside `setEnvironment("production")" — see the
    // TEST-HARNESS NOTE above; the production branch removing them is proven
    // independently by path 1/2/5-6's own tests, which do not depend on a
    // real SSR render to exercise).
    const payloadMatch = new RegExp(`<script id="${PAYLOAD_SCRIPT_ID}"[^>]*>(.*?)<\\/script>`).exec(
      rendered.html,
    );
    expect(payloadMatch).not.toBeNull();
    const payload = parse(payloadMatch![1]!) as { errorPage?: { error: { message: string } } };
    // The payload's error field is the SANITIZED SerializedPageError shape
    // (`{ name, message, stack? }`) regardless — never a raw Error instance,
    // never extra fields — proving the two channels genuinely diverge at
    // the source (`errorPageElement`'s raw `props` vs `hydrationErrorPageProps`'s
    // sanitized return), not merely by different test setup.
    expect(payload.errorPage).toBeDefined();
    expect(
      Object.keys(payload.errorPage!.error).every((key) =>
        ["name", "message", "stack"].includes(key),
      ),
    ).toBe(true);
  });

  it("PublicPageError is the one documented exception — its message is MEANT to reach the browser, everywhere", () => {
    setEnvironment("production");
    const serialized = serializePageError(new PublicPageError("This slug is already taken."));

    expect(serialized.message).toBe("This slug is already taken.");
  });
});
