/**
 * Card 0d43c0d6 — under a load test where clients disconnect mid-stream,
 * every aborted request used to log, at ERROR level, "[warlock:web] SSR
 * render error while rendering /posts/:slug: Error: The render was aborted
 * by the server without a reason." and reach the app's `web.errors.report()`
 * hook. A client disconnect is expected and already handled correctly (the
 * response is torn down, nothing leaks) — it must never be mistaken for a
 * genuine render failure.
 *
 * Two abort call sites reach the SAME React `PipeableStream.abort()`:
 *   - `render-page.ts`'s own listener on the per-request abort signal, for a
 *     page with no `defer()`-ed keys (added by this card — the common case,
 *     and the one this suite's RED-FIRST spec targets).
 *   - `defer-emission.ts`'s `onClientDisconnect`, for a page that does defer.
 * Both now abort with `ClientDisconnectedError` as the reason (its own file,
 * `client-disconnected-error.ts`) instead of no reason at all, and
 * `render-page.ts`'s `onError` recognises that reason and skips the report.
 *
 * RED CONTROL (recorded manually, per the card's instructions — a scratchpad
 * copy of `render-page.ts` with the `ClientDisconnectedError` check in
 * `onError` reverted to always call `reportRenderError`): the first spec
 * below fails with `console.error` having been called with the
 * "[warlock:web] SSR render error while rendering /disconnect-mid-stream:"
 * line, and the app hook spy having been called once — exactly the defect
 * this card closes. Restored immediately after confirming the failure; no
 * git command was used.
 */
import { EventEmitter } from "node:events";
import { createElement, Suspense, use } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import config from "@mongez/config";
import { createCoreHttp, requestContext } from "./__fixtures__/core-http";
import * as App from "../../__tests__/server/fixtures/root";
import * as layout from "../../__tests__/server/fixtures/layout";
import {
  connectPageContext,
  renderPageRequest,
  type PageContextRunner,
  type PageRouteEntry,
  type PageTripleModule,
} from "./index";
import { connectSharedStore, type SharedStoreResolver } from "../shared";
import { resetServerErrorReportingStateForTests } from "./report-server-error";

let previousRunner: PageContextRunner | undefined;
let previousResolver: SharedStoreResolver | undefined;

beforeAll(() => {
  previousRunner = connectPageContext(requestContext as unknown as PageContextRunner);
  previousResolver = connectSharedStore(() => requestContext.getStore() as never);
});

afterAll(() => {
  connectPageContext(previousRunner);
  connectSharedStore(previousResolver);
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  resetServerErrorReportingStateForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetServerErrorReportingStateForTests();
  config.set("web", {});
});

function pageEntry(path: string, page: Record<string, unknown>): PageRouteEntry {
  return {
    path,
    name: path.replace("/", ""),
    triple: {
      app: App as unknown as PageTripleModule,
      layout: layout as unknown as PageTripleModule,
      page: page as unknown as PageTripleModule,
    },
  };
}

/**
 * A page with a genuine React Suspense boundary that never settles — a
 * `use()` on a promise this test controls, never wrapped in the framework's
 * own `defer()` loader helper, so `bundle.deferredKeys` stays empty and the
 * render takes the PLAIN (non-`wrapPipeableStreamForDeferredEmission`) path
 * — the one `render-page.ts`'s own new abort wiring covers. The shell
 * ("main"/the Suspense fallback) is ready and on the wire almost
 * immediately; the boundary itself stays open until aborted or released,
 * which is what makes "disconnect mid-stream" real here rather than a
 * disconnect before anything streamed.
 */
function pendingBoundaryPage(never: Promise<never>) {
  function Slow() {
    use(never);
    return createElement("span", null, "unreachable");
  }

  return {
    default: () =>
      createElement(
        "main",
        null,
        "shell",
        createElement(Suspense, { fallback: "LOADING" }, createElement(Slow)),
      ),
  };
}

/** A page whose render throws synchronously — the genuine-failure control. */
function throwingPage() {
  return {
    default: () => {
      throw new Error("genuine render bug");
    },
  };
}

/** Real core Request/Response wired so `request-abort-signal.ts` fires. */
function createDisconnectableHttp(url: string) {
  const http = createCoreHttp({ url });
  // The fixture's fastify request shim carries no `.raw` (see
  // `__fixtures__/core-http.ts`'s header note) — `request-abort-signal.ts`
  // needs a real event target there to wire up at all, exactly like the
  // real `IncomingMessage` it stands in for.
  (http.request.baseRequest as unknown as { raw: EventEmitter }).raw = new EventEmitter();
  return http;
}

describe("card 0d43c0d6 — a client disconnect mid-stream is not reported as an SSR render error", () => {
  it("RED FIRST (would fail before the fix) — no console.error SSR-render-error line and no web.errors.report() call", async () => {
    const report = vi.fn();
    config.set("web", { errors: { report } });

    let releaseNever!: () => void;
    const never = new Promise<never>((_resolve, reject) => {
      releaseNever = () => reject(new Error("released after the test asserted — never read"));
    });
    // Silence the unhandled-rejection warning Node would otherwise print for
    // a promise this test intentionally never lets settle in a way anything
    // awaits.
    never.catch(() => undefined);

    const entry = pageEntry("/disconnect-mid-stream", pendingBoundaryPage(never));
    const http = createDisconnectableHttp("/disconnect-mid-stream");

    const rendered = await renderPageRequest("/disconnect-mid-stream", {
      routes: [entry],
      createHttp: () => ({ request: http.request, response: http.response }),
    });

    if (!("pipeableStream" in rendered) || !rendered.pipeableStream) {
      throw new Error("expected a streaming render");
    }

    http.response.setContentType("text/html");
    http.response.setStatusCode(rendered.status);

    // Fire the disconnect the instant the shell's first byte is on the wire
    // — a real "client went away mid-stream", not before anything streamed.
    // `stream-react-response.ts` (core) listens for this SAME "close" event
    // on the response's raw stream, so this is exactly the production
    // disconnect signal, not a framework-internal shortcut.
    http.reply.raw.once("data", () => {
      http.reply.raw.emit("close");
    });

    await http.response.streamReact(rendered.pipeableStream);

    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining("SSR render error while rendering"),
      expect.anything(),
    );
    expect(report).not.toHaveBeenCalled();

    releaseNever();
  });

  it("control: a genuine render throw still reports through console.error and web.errors.report()", async () => {
    const report = vi.fn();
    config.set("web", { errors: { report } });

    const entry = pageEntry("/genuine-render-bug", throwingPage());
    const http = createDisconnectableHttp("/genuine-render-bug");

    const rendered = await renderPageRequest("/genuine-render-bug", {
      routes: [entry],
      createHttp: () => ({ request: http.request, response: http.response }),
      loadErrorPage: async () => ({
        default: () => createElement("span", null, "error page"),
      }),
    });

    if (!("pipeableStream" in rendered) || !rendered.pipeableStream) {
      throw new Error("expected a streaming render");
    }

    http.response.setContentType("text/html");
    http.response.setStatusCode(rendered.status);
    await http.response.streamReact(rendered.pipeableStream);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("SSR render error while rendering"),
      expect.anything(),
    );
    await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(1);
  });
});
