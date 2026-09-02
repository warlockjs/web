import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpContext } from "@warlock.js/core";
import {
  createPageRouteHandler,
  type PageModuleLoader,
} from "../../src/server/create-page-route-handler";
import {
  connectPageContext,
  connectPageRoutes,
  type BufferedCookie,
  type PageContextRunner,
  type PageRoutesRegistry,
} from "../../src/server/index";
import { connectSharedStore, type SharedStoreResolver } from "../../src/shared";
import { expectHydrationPayloadKeys } from "../shared/expect-payload-keys";
import { requestContext } from "./fixtures/core-http";
import * as App from "./fixtures/root";
import * as contactPage from "./fixtures/contact.page";
import * as layout from "./fixtures/layout";

/**
 * `createPageRouteHandler` — the page handler as a standalone unit.
 *
 * THE POINT of this file: the handler is constructed here with a plain async
 * function as its module loader. No Vite dev server, no Fastify, no `app/`
 * directory scan, no `installPageRoutes`. That is the property the extraction
 * exists to create (`web/src/server/create-page-route-handler.ts`) — before
 * it, the same code was an anonymous closure inside `installPageRoutes`
 * (`install-page-routes.ts:236-275`, pre-extraction copy in
 * `scratchpad/install-page-routes.ts.orig`) and reaching it at all required
 * booting Vite.
 *
 * The App/layout/page modules are the SAME fixtures the pipeline specs use, so
 * "it renders" here means the real stages 1-10, not a stub.
 */

const APP_FILE = "/fixtures/web/root.tsx";
const LAYOUT_FILE = "/fixtures/web/layout.tsx";
const PAGE_FILE = "/fixtures/web/contact-us.page.tsx";

let previousRunner: PageContextRunner | undefined;
let previousResolver: SharedStoreResolver | undefined;
let previousRegistry: PageRoutesRegistry | undefined;

beforeAll(() => {
  // The pipeline's two boot-time seams. The handler does not own them — the
  // server bootstrap does (`execute-page-request.ts:102-114`) — so a unit test
  // of the handler has to stand them up exactly as the bootstrap would.
  previousRunner = connectPageContext(requestContext as unknown as PageContextRunner);
  previousResolver = connectSharedStore(() => requestContext.getStore() as never);
  // Deliberately UNSET: the handler must render off the one-entry registry it
  // builds per request, never off a connected global one. Leaving a registry
  // here would let a handler that forgot to pass `routes` still pass.
  previousRegistry = connectPageRoutes(undefined);
});

afterAll(() => {
  connectPageContext(previousRunner);
  connectSharedStore(previousResolver);
  connectPageRoutes(previousRegistry);
});

beforeEach(() => {
  // This machine exports NODE_ENV=production globally (A.3 §5 finding).
  vi.stubEnv("NODE_ENV", "development");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The fake module source: a Map lookup, which is the whole dependency. */
function moduleLoader(modules: Record<string, unknown>): {
  loadModule: PageModuleLoader;
  requested: string[];
} {
  const requested: string[] = [];

  return {
    requested,
    loadModule: async (moduleId: string) => {
      requested.push(moduleId);

      const module = modules[moduleId];

      if (!module) throw new Error(`fake loader: nothing registered for "${moduleId}"`);

      return module;
    },
  };
}

type RecordedContext = {
  context: HttpContext;
  written: {
    html?: string;
    status?: number;
    sent?: unknown;
    sentStatus?: number;
    contentType?: string;
  };
  appliedHeaders: Record<string, string>[];
  /** Single `header(key, value)` writes — the data path sets `Vary` this way. */
  singleHeaders: { key: string; value: unknown }[];
  appliedCookies: { response: unknown; cookie: BufferedCookie }[];
  applyBufferedCookie: (response: never, cookie: BufferedCookie) => void;
};

/**
 * A recording stand-in for core's request/response pair. Only the members the
 * handler and the pipeline actually touch: `path` and `nonce` (read by the
 * handler and by `documentSlotsFrom`), `input` (the fixture App/layout
 * middleware call it), and the three terminal writes.
 */
function recordingContext(
  url: string,
  nonce = "n0nc3",
  /**
   * Request headers, lowercased keys — how core's `request.header()` reads
   * them. Empty by default so every existing test keeps taking the DOCUMENT
   * path without restating that it wants HTML.
   */
  requestHeaders: Record<string, string> = {},
): RecordedContext {
  const written: RecordedContext["written"] = {};
  const appliedHeaders: Record<string, string>[] = [];
  const singleHeaders: { key: string; value: unknown }[] = [];
  const appliedCookies: { response: unknown; cookie: BufferedCookie }[] = [];
  const baseResponse = { marker: "fastify-reply" };

  const response = {
    baseResponse,
    /**
     * `sealShared()` normalizes the shared context through the store's own
     * `response.parse` (`web/src/shared.ts:337-341`, core's
     * `Response.parse`, response.ts:297). The fixtures put only plain values
     * in `shared`, for which core's parse is identity — so identity is the
     * faithful stand-in, and its ABSENCE is a loud throw, never a silent skip.
     */
    parse: async (value: unknown) => value,
    /**
     * The commit stage ALSO mirrors every committed header and the status onto
     * the live response (`commitBuffers`, execute-page-request.ts:430-431)
     * before the handler applies its own — present here so the fixture is
     * faithful to that, not because the handler reads any of it back.
     *
     * COOKIES ARE NOT MIRRORED. `header()`/`setStatusCode()` are keyed SETs and
     * so are idempotent with the emit's own writes; `cookie()` APPENDS, so
     * mirroring it put the same `Set-Cookie` on the wire twice. The emit
     * (`createPageRouteHandler`, via `applyBufferedCookie`) is the single site
     * that puts a committed cookie on the wire. `cookie()` is kept here only
     * so an unexpected call is a no-op stand-in rather than a crash.
     */
    header(key: string, value: unknown) {
      singleHeaders.push({ key, value });
      return response;
    },
    cookie() {
      return response;
    },
    setStatusCode() {
      return response;
    },
    headers(map: Record<string, string>) {
      appliedHeaders.push(map);
      return response;
    },
    async html(html: string, status?: number) {
      written.html = html;
      written.status = status;
      return response;
    },
    /**
     * The DATA path's terminal write, the counterpart of `html()` above.
     *
     * The body arrives ALREADY SERIALIZED — the handler stringifies it rather
     * than handing core an object, so that this path and the document path use
     * the same `JSON.stringify` and cannot produce different JSON. Recorded raw
     * here; the tests parse it, which is also what asserts it is valid JSON.
     */
    async send(data: unknown, status?: number) {
      written.sent = data;
      written.sentStatus = status;
      return response;
    },
    setContentType(contentType: string) {
      written.contentType = contentType;
      return response;
    },
  };

  const request = {
    path: url,
    nonce,
    input: () => undefined,
    /** Mirrors core's `Request.header(name, defaultValue)` — lowercased lookup. */
    header: (name: string, defaultValue: unknown = null) =>
      requestHeaders[name.toLowerCase()] ?? defaultValue,
  };

  return {
    context: { request, response } as unknown as HttpContext,
    written,
    appliedHeaders,
    singleHeaders,
    appliedCookies,
    applyBufferedCookie: (response, cookie) => {
      appliedCookies.push({ response, cookie });
    },
  };
}

describe("createPageRouteHandler — constructible without Vite", () => {
  it("renders the page through the injected module loader and flushes the document", async () => {
    const { loadModule, requested } = moduleLoader({
      [APP_FILE]: App,
      [LAYOUT_FILE]: layout,
      [PAGE_FILE]: contactPage,
    });
    const recorded = recordingContext("/contact-us");

    const handler = createPageRouteHandler({
      path: "/contact-us",
      name: "main.contact-us",
      appFile: APP_FILE,
      pageFile: PAGE_FILE,
      layoutFile: LAYOUT_FILE,
      loadModule,
      applyBufferedCookie: recorded.applyBufferedCookie as never,
      httpServer: undefined,
    });

    await handler(recorded.context);

    // The triple, in the order the pre-extraction `Promise.all` used
    // (`install-page-routes.ts:239-243`): app, layout, page.
    expect(requested).toEqual([APP_FILE, LAYOUT_FILE, PAGE_FILE]);

    // It RENDERED — a complete document, every level of the triple present.
    expect(recorded.written.status).toBe(200);
    expect(recorded.written.html?.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(recorded.written.html).toContain('<div id="app"');
    expect(recorded.written.html).toContain('<div id="layout">');
    expect(recorded.written.html).toContain("<h1>Contact us</h1>");

    // Stage 10a: one headers() call with the whole committed map, including
    // the framework's closed-by-default `cache-control` (README rule 8).
    expect(recorded.appliedHeaders).toHaveLength(1);
    expect(recorded.appliedHeaders[0]["cache-control"]).toBe("private");
  });

  it("loads no layout module and renders anyway when the page has none", async () => {
    const { loadModule, requested } = moduleLoader({
      [APP_FILE]: App,
      [PAGE_FILE]: contactPage,
    });
    const recorded = recordingContext("/contact-us");

    const handler = createPageRouteHandler({
      path: "/contact-us",
      name: "main.contact-us",
      appFile: APP_FILE,
      pageFile: PAGE_FILE,
      layoutFile: undefined,
      loadModule,
      applyBufferedCookie: recorded.applyBufferedCookie as never,
      httpServer: undefined,
    });

    await handler(recorded.context);

    // The layout slot is the literal `{}` the pre-extraction handler used, not
    // a fourth load and not a skipped slot.
    expect(requested).toEqual([APP_FILE, PAGE_FILE]);
    expect(recorded.written.html).toContain("<h1>Contact us</h1>");
    expect(recorded.written.html).not.toContain('<div id="layout">');
  });

  it("splices the hydration module in before the last </body>, nonce escaped", async () => {
    const { loadModule } = moduleLoader({
      [APP_FILE]: App,
      [LAYOUT_FILE]: layout,
      [PAGE_FILE]: contactPage,
    });
    const recorded = recordingContext("/contact-us", 'a"b');

    const handler = createPageRouteHandler({
      path: "/contact-us",
      name: "main.contact-us",
      appFile: APP_FILE,
      pageFile: PAGE_FILE,
      layoutFile: LAYOUT_FILE,
      loadModule,
      hydrationClientModuleUrl: "/@fs/hydration.tsx",
      applyBufferedCookie: recorded.applyBufferedCookie as never,
      httpServer: undefined,
    });

    await handler(recorded.context);

    const html = recorded.written.html ?? "";
    const script = '<script type="module" nonce="a&quot;b" src="/@fs/hydration.tsx"></script>';

    expect(html).toContain(script);
    // Position is the assertion: inside the document, immediately before the
    // closing body tag — a script appended after </body> is a different bug
    // that a bare `toContain` would happily pass.
    expect(html.indexOf(script)).toBe(html.lastIndexOf("</body>") - script.length);
  });

  it("applies every committed cookie to the core Response, in commit order", async () => {
    // A page whose loader writes two cookies and a header — the buffered
    // surface the commit stage drains (`buffered-response.ts:76-92`).
    const cookiePage = {
      loader: async ({ response }: { response: any }) => {
        response.cookie("first", "1", { httpOnly: true });
        response.cookie("second", "2", { sameSite: "lax" });
        response.header("x-page", "yes");

        return { ok: true };
      },
      default: () => null,
    };

    const { loadModule } = moduleLoader({
      [APP_FILE]: App,
      [PAGE_FILE]: cookiePage,
    });
    const recorded = recordingContext("/contact-us");

    const handler = createPageRouteHandler({
      path: "/contact-us",
      name: "main.contact-us",
      appFile: APP_FILE,
      pageFile: PAGE_FILE,
      loadModule,
      applyBufferedCookie: recorded.applyBufferedCookie as never,
      httpServer: undefined,
    });

    await handler(recorded.context);

    // Attribute-faithful and in order, handed the core `Response` itself —
    // `applyBufferedCookie` commits through `Response.cookie()`, so it needs the
    // wrapper, not the fastify reply underneath it.
    expect(recorded.appliedCookies.map(({ cookie }) => cookie)).toEqual([
      { name: "first", value: "1", options: { httpOnly: true } },
      { name: "second", value: "2", options: { sameSite: "lax" } },
    ]);
    expect(recorded.appliedCookies[0].response).toBe(recorded.context.response);
    expect(recorded.appliedHeaders[0]["x-page"]).toBe("yes");
  });
});

/**
 * The DATA representation of a page route.
 *
 * A client navigation asks the SAME route for the same work and wants the
 * hydration payload as JSON instead of a document. These tests pin the two
 * halves of that contract: what changes (the terminal write) and — the half
 * that actually matters — what does NOT (cookies, headers, status, and the
 * payload's shape, which must equal the one embedded in the document).
 */
describe("createPageRouteHandler — data requests", () => {
  const dataHeaders = { "x-warlock-data": "1" };

  it("returns the hydration payload as JSON and writes no document", async () => {
    const { loadModule } = moduleLoader({
      [APP_FILE]: App,
      [LAYOUT_FILE]: layout,
      [PAGE_FILE]: contactPage,
    });
    const recorded = recordingContext("/contact-us", "n0nc3", dataHeaders);

    const handler = createPageRouteHandler({
      path: "/contact-us",
      name: "main.contact-us",
      appFile: APP_FILE,
      pageFile: PAGE_FILE,
      layoutFile: LAYOUT_FILE,
      loadModule,
      applyBufferedCookie: recorded.applyBufferedCookie as never,
      httpServer: undefined,
    });

    await handler(recorded.context);

    // The document was never written — that is the whole difference.
    expect(recorded.written.html).toBeUndefined();
    expect(recorded.written.sentStatus).toBe(200);

    const payload = JSON.parse(recorded.written.sent as string) as Record<string, unknown>;

    // Every key the hydration contract requires, and the route NAME the
    // browser uses to pick the page instead of re-matching the pathname.
    expectHydrationPayloadKeys(payload);
    expect(payload.name).toBe("main.contact-us");
    expect(recorded.written.contentType).toBe("application/json");
  });

  /**
   * THE INVARIANT the split representation exists to preserve: the JSON a
   * client navigation receives is byte-for-byte the JSON the document embeds
   * for the same URL. If these ever diverge, a page behaves one way when you
   * land on it and another when you navigate to it.
   */
  it("sends byte-identical JSON to what the document embeds for the same URL", async () => {
    const modules = { [APP_FILE]: App, [LAYOUT_FILE]: layout, [PAGE_FILE]: contactPage };

    const asDocument = recordingContext("/contact-us");
    const asData = recordingContext("/contact-us", "n0nc3", dataHeaders);

    for (const recorded of [asDocument, asData]) {
      await createPageRouteHandler({
        path: "/contact-us",
        name: "main.contact-us",
        appFile: APP_FILE,
        pageFile: PAGE_FILE,
        layoutFile: LAYOUT_FILE,
        loadModule: moduleLoader(modules).loadModule,
        applyBufferedCookie: recorded.applyBufferedCookie as never,
        httpServer: undefined,
      })(recorded.context);
    }

    // The document carries the payload inside its #__WARLOCK_DATA__ script.
    const embedded = /<script id="__WARLOCK_DATA__"[^>]*>(.*?)<\/script>/s.exec(
      asDocument.written.html ?? "",
    );

    expect(embedded, "the document must embed a payload to compare against").not.toBeNull();
    expect(JSON.parse(asData.written.sent as string)).toEqual(JSON.parse(embedded![1] as string));
  });

  it("declares Vary so a cache cannot serve a document to a data request", async () => {
    const { loadModule } = moduleLoader({ [APP_FILE]: App, [PAGE_FILE]: contactPage });
    const recorded = recordingContext("/contact-us", "n0nc3", dataHeaders);

    await createPageRouteHandler({
      path: "/contact-us",
      name: "main.contact-us",
      appFile: APP_FILE,
      pageFile: PAGE_FILE,
      loadModule,
      applyBufferedCookie: recorded.applyBufferedCookie as never,
      httpServer: undefined,
    })(recorded.context);

    expect(
      recorded.singleHeaders.some(
        (entry) => entry.key === "Vary" && entry.value === "x-warlock-data",
      ),
    ).toBe(true);
  });

  /**
   * THE REGRESSION THIS PAIR EXISTS FOR.
   *
   * The data path is allowed to change the representation and nothing else. A
   * navigation that silently dropped a `Set-Cookie` would let a user log in by
   * full page load and not by clicking a link — a difference nobody would look
   * for, because the first visit is the one everybody tests.
   */
  it("applies committed cookies and headers exactly as the document path does", async () => {
    const modules = { [APP_FILE]: App, [PAGE_FILE]: contactPage };

    const asDocument = recordingContext("/contact-us");
    const asData = recordingContext("/contact-us", "n0nc3", dataHeaders);

    for (const recorded of [asDocument, asData]) {
      await createPageRouteHandler({
        path: "/contact-us",
        name: "main.contact-us",
        appFile: APP_FILE,
        pageFile: PAGE_FILE,
        loadModule: moduleLoader(modules).loadModule,
        applyBufferedCookie: recorded.applyBufferedCookie as never,
        httpServer: undefined,
      })(recorded.context);
    }

    expect(asData.appliedCookies.map((entry) => entry.cookie)).toEqual(
      asDocument.appliedCookies.map((entry) => entry.cookie),
    );
    expect(asData.appliedHeaders).toEqual(asDocument.appliedHeaders);
    expect(asData.written.sentStatus).toBe(asDocument.written.status);
  });

  it("still renders a document when the marker header is absent or empty", async () => {
    for (const headers of [{}, { "x-warlock-data": "" }]) {
      const recorded = recordingContext("/contact-us", "n0nc3", headers);

      await createPageRouteHandler({
        path: "/contact-us",
        name: "main.contact-us",
        appFile: APP_FILE,
        pageFile: PAGE_FILE,
        loadModule: moduleLoader({ [APP_FILE]: App, [PAGE_FILE]: contactPage }).loadModule,
        applyBufferedCookie: recorded.applyBufferedCookie as never,
        httpServer: undefined,
      })(recorded.context);

      expect(recorded.written.html?.startsWith("<!DOCTYPE html>")).toBe(true);
      expect(recorded.written.sent).toBeUndefined();
    }
  });
});
