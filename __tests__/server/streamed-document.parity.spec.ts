/**
 * STREAMED DOCUMENT — Stage 1 streaming SSR gate over the production seams
 * `render-page.ts`'s `finishRender`/`renderElementToPipeableStream`,
 * `create-page-route-handler.ts`'s `rendered.pipeableStream` branch, and
 * core's `Response.streamReact`/`streamReactResponse`.
 *
 * The contract this file gates: the first byte only goes out after loaders,
 * validation, middleware and error escalation have settled (status, headers
 * and cookies are decided exactly as before), and only WHAT PUTS BYTES ON
 * THE WIRE changed — a piped React stream instead of a buffered
 * `response.html()` send. Three properties, three describe blocks:
 *
 *   1. Parity   — the streamed body is the SAME bytes the buffered
 *                  (`renderToString`) path would have produced.
 *   2. Timing   — nothing reaches the raw response until a slow loader
 *                  resolves.
 *   3. Disconnect — a client going away mid-stream aborts the React render.
 *
 * Real core `Request`/`Response` throughout (`createCoreHttp`,
 * `fixtures/core-http.ts`), the same construction `page-redirect-wire.spec.ts`
 * and `create-page-route-handler.spec.ts` (this directory) use — a hand mock
 * of `response.streamReact` would prove nothing about the real wire seam this
 * file exists to gate.
 *
 * Lives under `__tests__/server/`, not co-located in `src/server/`, because it
 * imports the real-Request/Response fixtures under `./fixtures/`, which sit
 * outside `web/tsconfig.json`'s `rootDir` (`./src`) — the same placement
 * `page-redirect-wire.spec.ts` and this directory's own
 * `create-page-route-handler.spec.ts` already use for exactly that reason.
 */
import { createElement } from "react";
import type { PipeableStream } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Response, type HttpContext } from "@warlock.js/core";
import { PAYLOAD_SCRIPT_ID } from "../../src/components/document-context";
import { createCoreHttp, requestContext } from "./fixtures/core-http";
import * as App from "./fixtures/root";
import * as layout from "./fixtures/layout";
import { createPageRouteHandler, type PageModuleLoader } from "../../src/server/create-page-route-handler";
import {
  connectPageContext,
  renderPageRequest,
  type PageContextRunner,
  type PageRouteEntry,
  type PageTripleModule,
} from "../../src/server/index";
import { connectSharedStore, type SharedStoreResolver } from "../../src/shared";

/**
 * Every `PipeableStream` the REAL `renderToPipeableStream` ever produced in
 * this file, in creation order, with its `.abort()` replaced by a spy that
 * still calls straight through to the original. `vi.spyOn` cannot target an
 * ESM named export directly ("Module namespace is not configurable in ESM"),
 * so this wraps the export at the module-mock boundary instead — the only
 * spec-side way to observe calls to the REAL stream's `.abort()` (the thing
 * `stream-react-response.ts` calls on a disconnect) without hand-rolling a
 * fake `PipeableStream`, which would only prove this file's own fixture
 * wiring and nothing about the real `render-page.ts` -> core
 * `Response.streamReact` seam.
 */
const { capturedStreams } = vi.hoisted(() => ({
  capturedStreams: [] as Array<PipeableStream & { abort: ReturnType<typeof import("vitest").vi.fn> }>,
}));

vi.mock("react-dom/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/server")>();
  const { vi: vitest } = await import("vitest");

  return {
    ...actual,
    renderToPipeableStream: (
      ...args: Parameters<typeof actual.renderToPipeableStream>
    ): PipeableStream => {
      const stream = actual.renderToPipeableStream(...args);
      const realAbort = stream.abort.bind(stream);
      const abortSpy = vitest.fn((reason?: unknown) => realAbort(reason));

      stream.abort = abortSpy;
      capturedStreams.push(stream as never);

      return stream;
    },
  };
});

const APP_FILE = "/fixtures/web/root.tsx";
const LAYOUT_FILE = "/fixtures/web/layout.tsx";
const PAGE_FILE = "/fixtures/web/streamed.page.tsx";

let previousRunner: PageContextRunner | undefined;
let previousResolver: SharedStoreResolver | undefined;

beforeAll(() => {
  // The same two boot-time seams every other real-Request/Response server
  // spec wires up (`page-redirect-wire.spec.ts`,
  // `create-page-route-handler.spec.ts`) — the fixture App/layout write to
  // `shared` and expect a live page context.
  previousRunner = connectPageContext(requestContext as unknown as PageContextRunner);
  previousResolver = connectSharedStore(() => requestContext.getStore() as never);
});

afterAll(() => {
  connectPageContext(previousRunner);
  connectSharedStore(previousResolver);
});

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function moduleLoader(modules: Record<string, unknown>): PageModuleLoader {
  return async (moduleId: string) => {
    const module = modules[moduleId];

    if (!module) throw new Error(`fake loader: nothing registered for "${moduleId}"`);

    return module;
  };
}

/** Flush every pending microtask AND macrotask — the module-load `Promise.all`, the pipeline's own internal awaits, and anything a gated loader is holding open all need to settle before an assertion can trust "nothing happened yet". */
async function flushAsyncWork(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// 1. PARITY — the streamed body equals the buffered (renderToString) body
// ---------------------------------------------------------------------------

describe("streamed document parity — streamed bytes equal the buffered renderToString bytes", () => {
  /**
   * A representative page: App + Layout (both with their own loader data,
   * `./fixtures/root.tsx` / `layout.tsx`) + a page with its OWN loader data,
   * a stylesheet, the hydration payload script, and the hydration client
   * entry script carrying the request's CSP nonce.
   */
  it(
    "puts byte-identical bytes on the wire to what render-page.ts's own buffered .html describes for the SAME render",
    async () => {
      const stylesheetUrls = ["/assets/app.css"];
      const hydrationClientModuleUrl = "/@fs/hydrate.tsx";

      const page = {
        loader: async () => ({ greeting: "Hello streaming" }),
        default: ({ data }: { data: { greeting: string } }) =>
          createElement("main", null, createElement("h1", null, data.greeting)),
      };

      const entry: PageRouteEntry = {
        path: "/dashboard",
        name: "dashboard",
        triple: {
          app: App as unknown as PageTripleModule,
          layout: layout as unknown as PageTripleModule,
          page: page as unknown as PageTripleModule,
        },
      };

      const http = createCoreHttp({ url: "/dashboard" });

      // Attached BEFORE anything renders — `createReplyShim`'s raw PassThrough
      // is already flowing (`.resume()`), so a listener attached late would
      // silently miss bytes rather than fail loud.
      const chunks: Buffer[] = [];
      http.reply.raw.on("data", (chunk: Buffer) => chunks.push(chunk));

      const rendered = await renderPageRequest("/dashboard", {
        routes: [entry],
        createHttp: () => ({ request: http.request, response: http.response }),
        stylesheetUrls,
        hydrationClientModuleUrl,
      });

      if (rendered instanceof Response) {
        throw new Error("unexpected terminal Response for a page with no middleware/redirect");
      }

      expect(rendered.pipeableStream).toBeDefined();

      // Exactly what `create-page-route-handler.ts` does for a real request:
      // set the committed status/content-type, then hand the stream to
      // core's `Response.streamReact` — the ONE sanctioned place a
      // `PipeableStream` becomes bytes on the wire.
      http.response.setContentType("text/html");
      http.response.setStatusCode(rendered.status);
      await http.response.streamReact(rendered.pipeableStream!);

      const wireHtml = Buffer.concat(chunks).toString("utf8");

      // NORMALISATION: none, and none is legitimate here — not "none was
      // needed by luck". `finishRender` (render-page.ts, `RenderedPage.html`'s
      // own doc comment) builds `.html` via `renderToString` of the EXACT
      // SAME wrapped element that `.pipeableStream` (above) streams; the
      // escalation loop runs that `renderToString` pass first, synchronously,
      // specifically to prove the tree renders cleanly before the streaming
      // pass ever starts. So `wireHtml` and `rendered.html` are two different
      // React APIs (`renderToPipeableStream` piped through core's real
      // `Response.streamReact`, vs. `renderToString`) describing the
      // IDENTICAL element — nothing about representation, whitespace, or
      // ordering can legitimately differ between them, and this assertion
      // says so at the strongest level available: byte equality.
      expect(wireHtml).toBe(rendered.html);

      // The representative-page checklist, proven present in what the two
      // assertions above just proved are the same bytes: layout wraps the
      // page, the page's own loader data rendered, the stylesheet landed in
      // <head>, the hydration payload is embedded, and the client entry
      // script carries the SAME nonce as the request.
      expect(rendered.html).toContain('<div id="layout">');
      expect(rendered.html).toContain("Hello streaming");
      // React SSR self-closes void elements — `<link ... />`, not `<link ...>`.
      expect(rendered.html).toContain(`<link rel="stylesheet" href="${stylesheetUrls[0]}"/>`);
      expect(rendered.html).toContain(PAYLOAD_SCRIPT_ID);
      expect(rendered.html).toContain(
        `<script type="module" nonce="${http.request.nonce}" src="${hydrationClientModuleUrl}">`,
      );
    },
    20_000,
  );
});

// ---------------------------------------------------------------------------
// 2. TIMING — nothing reaches the raw response before a slow loader resolves
// ---------------------------------------------------------------------------

describe("first byte does not leave before loaders/validation/middleware settle", () => {
  it(
    "writes zero bytes and calls no writeHead while a page loader is still pending, then flushes once it resolves",
    async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const gatedPage = {
        loader: async () => {
          await gate;
          return { greeting: "released" };
        },
        default: ({ data }: { data: { greeting: string } }) =>
          createElement("main", null, data.greeting),
      };

      const http = createCoreHttp({ url: "/gated" });
      const writeHeadSpy = vi.spyOn(http.reply.raw, "writeHead");
      const chunks: Buffer[] = [];
      http.reply.raw.on("data", (chunk: Buffer) => chunks.push(chunk));

      const handler = createPageRouteHandler({
        path: "/gated",
        name: "gated",
        appFile: APP_FILE,
        pageFile: PAGE_FILE,
        layoutFile: undefined,
        loadModule: moduleLoader({ [APP_FILE]: App, [PAGE_FILE]: gatedPage }),
        applyBufferedCookie: () => undefined,
        httpServer: undefined,
      });

      const pending = handler({
        request: http.request,
        response: http.response,
      } as unknown as HttpContext);

      // Give every stage BEFORE the gated loader (module loading, middleware,
      // validation) every chance to run — if the contract were broken this
      // is where a premature write would already have happened.
      await flushAsyncWork();

      expect(writeHeadSpy).not.toHaveBeenCalled();
      expect(chunks).toHaveLength(0);
      expect(http.reply.sent).toBe(false);

      release();
      await pending;

      expect(writeHeadSpy).toHaveBeenCalledTimes(1);
      expect(chunks.length).toBeGreaterThan(0);
      expect(Buffer.concat(chunks).toString("utf8")).toContain("released");
    },
    20_000,
  );
});

// ---------------------------------------------------------------------------
// 3. DISCONNECT — a client going away mid-stream aborts the React render
// ---------------------------------------------------------------------------

describe("a client disconnect mid-stream aborts the React render", () => {
  beforeEach(() => {
    capturedStreams.length = 0;
  });

  it(
    "destroying the raw response before it finishes calls pipeableStream.abort()",
    async () => {
      const page = {
        default: () => createElement("main", null, "disconnect me"),
      };

      const entry: PageRouteEntry = {
        path: "/disconnect",
        name: "disconnect",
        triple: {
          app: App as unknown as PageTripleModule,
          layout: {} as PageTripleModule,
          page: page as unknown as PageTripleModule,
        },
      };

      const http = createCoreHttp({ url: "/disconnect" });

      // Hold the raw response open past its natural finish. Without this, a
      // tree this small (no Suspense — Stage 1 never has any) writes AND
      // ends synchronously inside `pipeableStream.pipe(raw)`, so by the time
      // this spec could destroy `raw` there would be no "mid-stream" window
      // left to interrupt — `raw.writableEnded` would already be true and
      // `streamReactResponse`'s own `if (raw.writableEnded) return;` guard
      // would (correctly) skip calling `abort()`, which is the CORRECT
      // behaviour for an already-finished response and would make this spec
      // assert nothing about a genuine disconnect at all.
      const realEnd = http.reply.raw.end.bind(http.reply.raw);
      http.reply.raw.end = (() => http.reply.raw) as typeof http.reply.raw.end;

      const rendered = await renderPageRequest("/disconnect", {
        routes: [entry],
        createHttp: () => ({ request: http.request, response: http.response }),
      });

      if (rendered instanceof Response) {
        throw new Error("unexpected terminal Response for a page with no middleware/redirect");
      }

      expect(rendered.pipeableStream).toBeDefined();
      expect(capturedStreams).toHaveLength(1);
      const captured = capturedStreams[0];

      if (!captured) {
        throw new Error(
          "expected the mocked renderToPipeableStream to have captured exactly one stream",
        );
      }

      // Exactly the production seam (`create-page-route-handler.ts`): hand
      // the stream to core's real `Response.streamReact`. Not awaited here on
      // purpose — a destroyed response with `end()` swallowed never fires
      // `"finish"`, so the returned promise never settles; the assertions
      // below only need `abort()` to have been called, not the promise to
      // resolve. Any eventual rejection is swallowed so it cannot surface as
      // an unhandled rejection once this test has already finished.
      void http.response.streamReact(rendered.pipeableStream!).catch(() => undefined);

      await flushAsyncWork();

      // Bytes really did start flowing (the render happened, it just never
      // "finished") — the genuine mid-stream state this spec exists to catch.
      expect(http.reply.raw.writableEnded).toBe(false);
      expect(captured.abort).not.toHaveBeenCalled();

      // The client goes away.
      http.reply.raw.destroy();

      await flushAsyncWork();

      expect(captured.abort).toHaveBeenCalledTimes(1);

      // Restore the real `end()` so nothing else in this suite inherits a
      // permanently-swallowed writable — `http.reply.raw` itself is already
      // destroyed and discarded with this test.
      http.reply.raw.end = realEnd;
    },
    20_000,
  );
});
