import { beforeEach, describe, expect, it, vi } from "vitest";
import { Response } from "@warlock.js/core";

const { renderPageRequest, renderPageFailure } = vi.hoisted(() => ({
  renderPageRequest: vi.fn(),
  renderPageFailure: vi.fn(),
}));

vi.mock("./render-page", () => ({ renderPageRequest, renderPageFailure }));

const { writeDeferredNdjsonResponse } = vi.hoisted(() => ({
  writeDeferredNdjsonResponse: vi.fn(async () => undefined),
}));

vi.mock("./write-deferred-ndjson-response", async () => {
  const actual = await vi.importActual<typeof import("./write-deferred-ndjson-response")>(
    "./write-deferred-ndjson-response",
  );

  return { ...actual, writeDeferredNdjsonResponse };
});

import { buildHydrationPayload } from "./build-hydration-payload";
import { createPageRouteHandler, type PageRouteHandlerOptions } from "./create-page-route-handler";
import { markNonHydrating } from "./page-render-bundle";
import type { RenderPageRequestOptions } from "./render-page";
import {
  DATA_RESPONSE_CONTENT_TYPE,
  WARLOCK_DATA_REQUEST_HEADER,
  WARLOCK_DATA_REQUEST_VALUE,
} from "../routing/data-request";

function renderedOk() {
  return {
    html: "",
    status: 200,
    headers: {},
    data: undefined,
    bundle: undefined,
  };
}

function context(
  path = "/account",
  params: Record<string, string> = {},
  query: Record<string, string> = {},
) {
  return {
    request: {
      path,
      params,
      query,
      locale: "en",
      header: vi.fn(() => undefined),
    },
    response: {
      headers: vi.fn(),
      // `applyResponseCacheFloor` (`response-cache-floor.ts`) now calls
      // `response.header(...)` on EVERY page response — the closed-by-default
      // `no-store` case included, not only the floor cases — so this mock
      // needs it even for tests that never touch cookies or auth.
      header: vi.fn(),
      html: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      // The streaming document path (`rendered.pipeableStream` present) goes
      // through these three instead of `.html()` — see
      // `createPageRouteHandler`'s non-data, non-short-circuit branch.
      setContentType: vi.fn(),
      setStatusCode: vi.fn(),
      streamReact: vi.fn(async () => undefined),
      // Card 2eb7ea7a's persistence call — see
      // "createPageRouteHandler — persisting a navigation-requested locale".
      setLocale: vi.fn(),
    },
  };
}

/** A fake React `PipeableStream` — `pipe`/`abort` are never called by this handler directly; it only hands the object to `response.streamReact`. */
function fakePipeableStream() {
  return { pipe: vi.fn(), abort: vi.fn() };
}

/**
 * A request carrying the data-request marker, with the response mocks the
 * `wantsData` branches actually call: `header` (singular — `Vary`),
 * `setContentType` and `send`. `context()`'s `response.html` stays present so
 * a wrongly-taken document path is still visible as a spurious call.
 */
function dataRequestContext(
  path = "/account",
  accept?: string,
  query: Record<string, string> = {},
  locale = "en",
) {
  const requestContext = context(path, {}, query);

  return {
    request: {
      ...requestContext.request,
      locale,
      header: vi.fn((name: string) => {
        if (name === WARLOCK_DATA_REQUEST_HEADER) return WARLOCK_DATA_REQUEST_VALUE;
        if (name === "accept") return accept;

        return undefined;
      }),
    },
    response: {
      ...requestContext.response,
      header: vi.fn(),
      setContentType: vi.fn(),
      setStatusCode: vi.fn(),
      send: vi.fn(async () => undefined),
      raw: { writeHead: vi.fn(), write: vi.fn(), end: vi.fn() },
      getHeaders: vi.fn(() => ({})),
      statusCode: 200,
      setLocale: vi.fn(),
    },
  };
}

function handlerOptions(
  moduleById: Record<string, unknown>,
  overrides: Partial<PageRouteHandlerOptions> = {},
): PageRouteHandlerOptions {
  return {
    path: "/account",
    name: "account",
    appFile: "app.tsx",
    layoutFile: "composed-layout.tsx",
    pageFile: "account.page.tsx",
    loadModule: async (moduleId) => moduleById[moduleId],
    httpServer: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  renderPageRequest.mockReset();
  renderPageRequest.mockResolvedValue(renderedOk());
  renderPageFailure.mockReset();
  writeDeferredNdjsonResponse.mockReset();
  writeDeferredNdjsonResponse.mockResolvedValue(undefined);
});

describe("createPageRouteHandler — universal registration", () => {
  it("hands core's selected route and multi-segment params to the page pipeline", async () => {
    const handler = createPageRouteHandler(
      handlerOptions(
        { "app.tsx": {}, "composed-layout.tsx": {}, "account.page.tsx": {} },
        { path: "/stores/:storeId/products/:productId", name: "product" },
      ),
    );

    await handler(
      context("/stores/cairo/products/42", { storeId: "cairo", productId: "42" }) as never,
    );

    const [, options] = renderPageRequest.mock.calls[0] as [string, RenderPageRequestOptions];
    expect(options.matched).toMatchObject({
      entry: { name: "product", path: "/stores/:storeId/products/:productId" },
      params: { storeId: "cairo", productId: "42" },
    });
  });

  it("preserves the catch-all page's param-free route convention", async () => {
    const handler = createPageRouteHandler(
      handlerOptions(
        { "app.tsx": {}, "composed-layout.tsx": {}, "account.page.tsx": {} },
        { path: "*", name: "not-found", matchPath: (requestPath) => requestPath },
      ),
    );

    await handler(context("/missing/a/deep/path", { "*": "missing/a/deep/path" }) as never);

    const [, options] = renderPageRequest.mock.calls[0] as [string, RenderPageRequestOptions];
    expect(options.matched).toMatchObject({
      entry: { name: "not-found", path: "/missing/a/deep/path" },
      params: {},
    });
  });

  it("preserves a terminal core Response and skips every normal emit step", async () => {
    const terminal = new Response();
    const requestContext = context();
    const handler = createPageRouteHandler(
      handlerOptions({
        "app.tsx": {},
        "composed-layout.tsx": {},
        "account.page.tsx": {},
      }),
    );

    renderPageRequest.mockResolvedValue(terminal);

    const result = await handler(requestContext as never);

    expect(result).toBe(terminal);
    expect(requestContext.response.headers).not.toHaveBeenCalled();
    expect(requestContext.response.html).not.toHaveBeenCalled();
  });

  it("registers App, real layouts outermost-first, and page before render", async () => {
    const calls: string[] = [];
    const app = { register: () => calls.push("app") };
    const outerLayout = { register: () => calls.push("outer layout") };
    const innerLayout = { register: () => calls.push("inner layout") };
    const syntheticLayout = { register: () => calls.push("synthetic layout") };
    const page = { register: () => calls.push("page") };

    renderPageRequest.mockImplementation(async () => {
      calls.push("render");
      return renderedOk();
    });

    const handler = createPageRouteHandler(
      handlerOptions(
        {
          "app.tsx": app,
          "composed-layout.tsx": syntheticLayout,
          "account.page.tsx": page,
        },
        { loadRegistrationLayouts: async () => [outerLayout, innerLayout] },
      ),
    );

    await handler(context() as never);

    expect(calls).toEqual(["app", "outer layout", "inner layout", "page", "render"]);
    expect(calls).not.toContain("synthetic layout");
  });

  it("runs each namespace once across requests and routes that share App and layout", async () => {
    const calls: string[] = [];
    const app = { register: () => calls.push("app") };
    const sharedLayout = { register: () => calls.push("layout") };
    const firstPage = { register: () => calls.push("first page") };
    const secondPage = { register: () => calls.push("second page") };
    const moduleById = {
      "app.tsx": app,
      "layout.tsx": sharedLayout,
      "first.page.tsx": firstPage,
      "second.page.tsx": secondPage,
    };
    const loadRegistrationLayouts = async () => [sharedLayout];
    const first = createPageRouteHandler(
      handlerOptions(moduleById, {
        layoutFile: "layout.tsx",
        pageFile: "first.page.tsx",
        loadRegistrationLayouts,
      }),
    );
    const second = createPageRouteHandler(
      handlerOptions(moduleById, {
        layoutFile: "layout.tsx",
        pageFile: "second.page.tsx",
        loadRegistrationLayouts,
      }),
    );

    await first(context("/first") as never);
    await first(context("/first") as never);
    await second(context("/second") as never);

    expect(calls).toEqual(["app", "layout", "first page", "second page"]);
    expect(renderPageRequest).toHaveBeenCalledTimes(3);
  });

  it("lets a register throw escape to the existing router error path before render", async () => {
    const failure = new Error("register failed");
    const handler = createPageRouteHandler(
      handlerOptions({
        "app.tsx": { register: () => undefined },
        "composed-layout.tsx": {},
        "account.page.tsx": {
          register: () => {
            throw failure;
          },
        },
      }),
    );

    await expect(handler(context() as never)).rejects.toBe(failure);
    expect(renderPageRequest).not.toHaveBeenCalled();
  });

  it("registers App then the custom 404 page before rendering it, with no layout identity", async () => {
    const calls: string[] = [];
    const loader = vi.fn(() => ({ shouldNotRun: true }));
    const Page = () => null;
    const notFoundModule = { register: () => calls.push("404"), loader };
    Object.defineProperty(notFoundModule, "default", { value: Page, enumerable: false });
    const responseContext = context("/missing/path?t=trace-token");
    const handler = createPageRouteHandler(
      handlerOptions(
        {
          "app.tsx": { register: () => calls.push("app") },
          "404.page.tsx": notFoundModule,
        },
        {
          path: "*",
          name: "warlock.not-found",
          layoutFile: undefined,
          pageFile: "404.page.tsx",
          matchPath: (requestPath) => requestPath,
          statusForRenderedOk: 404,
          skipPageLoader: true,
        },
      ),
    );

    renderPageRequest.mockImplementation(async (url: string, options: RenderPageRequestOptions) => {
      calls.push("render");
      expect(url).toBe("/missing/path?t=trace-token");
      expect(options.routes?.[0]?.path).toBe("/missing/path");
      expect(options.routes?.[0]?.triple.page.loader).toBeUndefined();
      expect(options.routes?.[0]?.triple.page.default).toBe(Page);
      return renderedOk();
    });

    await handler(responseContext as never);

    expect(calls).toEqual(["app", "404", "render"]);
    expect(loader).not.toHaveBeenCalled();
    expect(responseContext.response.html).toHaveBeenCalledWith("", 404);
  });

  it("preserves the loader on an ordinary page triple", async () => {
    const loader = vi.fn(() => ({ account: true }));
    const handler = createPageRouteHandler(
      handlerOptions({
        "app.tsx": {},
        "composed-layout.tsx": {},
        "account.page.tsx": { loader },
      }),
    );

    renderPageRequest.mockImplementation(
      async (_url: string, options: RenderPageRequestOptions) => {
        expect(options.routes?.[0]?.triple.page.loader).toBe(loader);
        return renderedOk();
      },
    );

    await handler(context() as never);
  });
});

describe("createPageRouteHandler — streaming document render", () => {
  it("streams an ordinary render through core's Response.streamReact instead of a buffered send", async () => {
    const pipeableStream = fakePipeableStream();
    renderPageRequest.mockResolvedValue({
      html: "<html><body></body></html>",
      status: 200,
      headers: {},
      data: undefined,
      bundle: { route: { name: "account", path: "/account", params: {}, query: {} } },
      pipeableStream,
    });

    const requestContext = context();
    const handler = createPageRouteHandler(
      handlerOptions(
        { "app.tsx": {}, "composed-layout.tsx": {}, "account.page.tsx": {} },
        { hydrationClientModuleUrl: "/hydrate.js" },
      ),
    );

    await handler(requestContext as never);

    expect(requestContext.response.setContentType).toHaveBeenCalledWith("text/html");
    expect(requestContext.response.setStatusCode).toHaveBeenCalledWith(200);
    expect(requestContext.response.streamReact).toHaveBeenCalledWith(pipeableStream);
    // The streaming path never falls back to a buffered send — this handler
    // never touches `response.raw` itself, only `Response.streamReact`.
    expect(requestContext.response.html).not.toHaveBeenCalled();
  });

  it("passes stylesheetUrls, hydrationClientModuleUrl and a false waitForAll through to renderPageRequest, for DocumentContext to render", async () => {
    renderPageRequest.mockResolvedValue({
      html: "<html><body></body></html>",
      status: 200,
      headers: {},
      data: undefined,
      bundle: { route: { name: "account", path: "/account", params: {}, query: {} } },
      pipeableStream: fakePipeableStream(),
    });

    const handler = createPageRouteHandler(
      handlerOptions(
        { "app.tsx": {}, "composed-layout.tsx": {}, "account.page.tsx": {} },
        { hydrationClientModuleUrl: "/hydrate.js", stylesheetUrls: ["/app.css"] },
      ),
    );

    await handler(context() as never);

    const [, options] = renderPageRequest.mock.calls[0] as [string, RenderPageRequestOptions];
    expect(options.hydrationClientModuleUrl).toBe("/hydrate.js");
    expect(options.stylesheetUrls).toEqual(["/app.css"]);
    expect(options.waitForAll).toBe(false);
  });

  it("falls back to a plain buffered send when the render result carries no pipeableStream", async () => {
    renderPageRequest.mockResolvedValue({
      html: "<html><body>fallback</body></html>",
      status: 200,
      headers: {},
      data: undefined,
      bundle: { route: { name: "account", path: "/account", params: {}, query: {} } },
    });

    const requestContext = context();
    const handler = createPageRouteHandler(
      handlerOptions({ "app.tsx": {}, "composed-layout.tsx": {}, "account.page.tsx": {} }),
    );

    await handler(requestContext as never);

    expect(requestContext.response.html).toHaveBeenCalledWith(
      "<html><body>fallback</body></html>",
      200,
    );
    expect(requestContext.response.streamReact).not.toHaveBeenCalled();
  });

  it("sends renderPageFailure's pre-triple fallback html verbatim, with stylesheetUrls/hydrationClientModuleUrl passed through for it to render itself", async () => {
    renderPageFailure.mockResolvedValue({
      html: "<html><body></body></html>",
      status: 500,
      headers: {},
      data: undefined,
      bundle: markNonHydrating({
        route: { name: "account", path: "/account", params: {}, query: {} },
      }),
    });

    const requestContext = context();
    const handler = createPageRouteHandler(
      handlerOptions(
        {
          "app.tsx": {},
          "composed-layout.tsx": {},
          "account.page.tsx": {
            register: () => {
              throw new Error("register failed");
            },
          },
        },
        { hydrationClientModuleUrl: "/hydrate.js", stylesheetUrls: ["/app.css"] },
      ),
    );

    await handler(requestContext as never);

    expect(renderPageFailure).toHaveBeenCalled();
    const [failureOptions] = renderPageFailure.mock.calls[0] as [
      { hydrationClientModuleUrl?: string; stylesheetUrls?: readonly string[] },
    ];
    expect(failureOptions.hydrationClientModuleUrl).toBe("/hydrate.js");
    expect(failureOptions.stylesheetUrls).toEqual(["/app.css"]);
    // Exact match: `rendered.html` is returned byte-for-byte, with no
    // post-render splice of any kind — `renderPageFailure` is responsible
    // for its own document content now.
    expect(requestContext.response.html).toHaveBeenCalledWith("<html><body></body></html>", 500);
    expect(requestContext.response.streamReact).not.toHaveBeenCalled();
  });
});

describe("createPageRouteHandler — middleware 2xx short-circuit stays a plain buffered body", () => {
  it("sends a string middleware short-circuit value as-is, with no streaming and no stylesheet/hydration injection", async () => {
    renderPageRequest.mockResolvedValue({
      html: "plain text body",
      status: 200,
      headers: {},
      data: undefined,
      bundle: {
        route: { name: "account", path: "/account", params: {}, query: {} },
        shortCircuit: { stage: "middleware", statusCode: 200, responseSent: false, value: "plain text body" },
      },
    });

    const requestContext = context();
    const handler = createPageRouteHandler(
      handlerOptions(
        { "app.tsx": {}, "composed-layout.tsx": {}, "account.page.tsx": {} },
        { hydrationClientModuleUrl: "/hydrate.js", stylesheetUrls: ["/app.css"] },
      ),
    );

    await handler(requestContext as never);

    expect(requestContext.response.send).toHaveBeenCalledWith("plain text body", 200);
    expect(requestContext.response.streamReact).not.toHaveBeenCalled();
    expect(requestContext.response.html).not.toHaveBeenCalled();
    // The body is untouched — no `<link>`/`<script>` was ever spliced in.
    const sendMock = requestContext.response.send as ReturnType<typeof vi.fn>;
    const [sentBody] = sendMock.mock.calls[0] ?? [];

    expect(sentBody).not.toMatch(/<link|<script/);
  });

  it("JSON.stringifies a plain-object middleware short-circuit value and sends application/json, unaffected by stylesheets/hydration", async () => {
    const value = { message: "created" };
    renderPageRequest.mockResolvedValue({
      html: JSON.stringify(value),
      status: 201,
      headers: {},
      data: undefined,
      bundle: {
        route: { name: "account", path: "/account", params: {}, query: {} },
        shortCircuit: { stage: "middleware", statusCode: 201, responseSent: false, value },
      },
    });

    const requestContext = context();
    const handler = createPageRouteHandler(
      handlerOptions(
        { "app.tsx": {}, "composed-layout.tsx": {}, "account.page.tsx": {} },
        { hydrationClientModuleUrl: "/hydrate.js", stylesheetUrls: ["/app.css"] },
      ),
    );

    await handler(requestContext as never);

    expect(requestContext.response.setContentType).toHaveBeenCalledWith(
      "application/json; charset=utf-8",
    );
    expect(requestContext.response.send).toHaveBeenCalledWith(JSON.stringify(value), 201);
    expect(requestContext.response.streamReact).not.toHaveBeenCalled();
    expect(requestContext.response.html).not.toHaveBeenCalled();
  });
});

describe("createPageRouteHandler — fallback data requests", () => {
  it("answers an ordinary successful data request with the JSON payload, not the document", async () => {
    const bundle = {
      route: { name: "account", path: "/account", params: {}, query: {} },
    };
    renderPageRequest.mockResolvedValue({
      html: "<html><body></body></html>",
      status: 200,
      headers: {},
      data: undefined,
      bundle,
    });

    const requestContext = dataRequestContext();
    const handler = createPageRouteHandler(
      handlerOptions(
        { "app.tsx": {}, "composed-layout.tsx": {}, "account.page.tsx": {} },
        { hydrationClientModuleUrl: "/hydrate.js" },
      ),
    );

    await handler(requestContext as never);

    expect(requestContext.response.header).toHaveBeenCalledWith(
      "Vary",
      WARLOCK_DATA_REQUEST_HEADER,
    );
    expect(requestContext.response.setContentType).toHaveBeenCalledWith(DATA_RESPONSE_CONTENT_TYPE);
    // Serialized with the SAME transform the document embeds under
    // `#__WARLOCK_DATA__`, and sent as the already-stringified body the
    // production code documents at its call site — a JSON.stringify of an
    // object body here would silently change the wire format.
    expect(requestContext.response.send).toHaveBeenCalledWith(
      JSON.stringify(buildHydrationPayload(bundle as never, "en")),
      200,
    );
    expect(requestContext.response.html).not.toHaveBeenCalled();
  });

  it("answers a data request during renderPageFailure's catch fallback with JSON, unaffected by non-hydrating DOM suppression", async () => {
    const bundle = markNonHydrating({
      route: { name: "account", path: "/account", params: {}, query: {} },
    });
    renderPageFailure.mockResolvedValue({
      html: "<html><body></body></html>",
      status: 500,
      headers: {},
      data: undefined,
      bundle,
    });

    const requestContext = dataRequestContext();
    const handler = createPageRouteHandler(
      handlerOptions(
        {
          "app.tsx": {},
          "composed-layout.tsx": {},
          "account.page.tsx": {
            register: () => {
              throw new Error("register failed");
            },
          },
        },
        { hydrationClientModuleUrl: "/hydrate.js" },
      ),
    );

    await handler(requestContext as never);

    expect(renderPageFailure).toHaveBeenCalled();
    expect(requestContext.response.header).toHaveBeenCalledWith(
      "Vary",
      WARLOCK_DATA_REQUEST_HEADER,
    );
    expect(requestContext.response.setContentType).toHaveBeenCalledWith(DATA_RESPONSE_CONTENT_TYPE);
    // `markNonHydrating` is what makes the DOCUMENT branch skip splicing the
    // hydration client module (asserted above, in the non-data test) — it
    // says "there is no triple for a browser script to attach to". It says
    // nothing about the DATA branch: there is no script tag to omit here in
    // the first place, only a JSON body, and the catch handler sends the full
    // payload regardless of the bundle's hydration flag. Suppressing it too
    // would be a second, undocumented meaning smuggled onto the same flag.
    expect(requestContext.response.send).toHaveBeenCalledWith(
      JSON.stringify(buildHydrationPayload(bundle as never, "en")),
      500,
    );
    expect(requestContext.response.html).not.toHaveBeenCalled();
  });
});

describe("createPageRouteHandler — persisting a navigation-requested locale (card 2eb7ea7a)", () => {
  /**
   * `changeLocaleCode()`'s client half (`client/navigation/change-locale-code.ts`)
   * sends the switch as `?locale=<code>` on a navigation DATA request's fetch
   * URL only, never the visible one. This is the server half: persist that
   * choice through `response.setLocale()` — the SAME call an ordinary
   * controller would make, writing the SAME cookie `request.locale` already
   * read it back from (`core/src/http/request.ts:352-360`) — so a later full
   * load agrees without the query param travelling with it.
   *
   * `response.setLocale()` itself, and the cookie/`request.locale` round
   * trip it produces, are core's own contract, proven directly against the
   * REAL `Request`/`Response` pair by `core/src/http/response-set-locale.spec.ts`.
   * These specs are scoped to what THIS package owns: deciding WHEN to call
   * it.
   */
  it("persists the locale, via response.setLocale, on a data request carrying ?locale=", async () => {
    const bundle = {
      route: { name: "account", path: "/account", params: {}, query: { locale: "ar" } },
    };

    renderPageRequest.mockResolvedValue({
      html: "",
      status: 200,
      headers: {},
      data: undefined,
      bundle,
    });

    const requestContext = dataRequestContext("/account", undefined, { locale: "ar" }, "ar");
    const handler = createPageRouteHandler(
      handlerOptions({ "app.tsx": {}, "composed-layout.tsx": {}, "account.page.tsx": {} }),
    );

    await handler(requestContext as never);

    expect(requestContext.response.setLocale).toHaveBeenCalledTimes(1);
    expect(requestContext.response.setLocale).toHaveBeenCalledWith("ar");
  });

  it("does not persist when the data request carries no ?locale= param", async () => {
    const bundle = {
      route: { name: "account", path: "/account", params: {}, query: {} },
    };

    renderPageRequest.mockResolvedValue({
      html: "",
      status: 200,
      headers: {},
      data: undefined,
      bundle,
    });

    const requestContext = dataRequestContext("/account", undefined, {}, "en");
    const handler = createPageRouteHandler(
      handlerOptions({ "app.tsx": {}, "composed-layout.tsx": {}, "account.page.tsx": {} }),
    );

    await handler(requestContext as never);

    expect(requestContext.response.setLocale).not.toHaveBeenCalled();
  });

  it("does not persist on a document request carrying ?locale= — only a data request does", async () => {
    renderPageRequest.mockResolvedValue(renderedOk());

    const requestContext = context("/account", {}, { locale: "ar" });
    const handler = createPageRouteHandler(
      handlerOptions({ "app.tsx": {}, "composed-layout.tsx": {}, "account.page.tsx": {} }),
    );

    await handler(requestContext as never);

    expect(requestContext.response.setLocale).not.toHaveBeenCalled();
    // Confirms the document path actually ran, so a false pass (nothing ran
    // at all) cannot masquerade as this rule holding.
    expect(requestContext.response.html).toHaveBeenCalled();
  });

  /**
   * `request.locale`, never the raw query value, is what gets persisted:
   * `resolveLocale()` already ran the query value through `cacheLocale()`'s
   * `app.localeCodes` allow-list by the time this handler reads
   * `request.locale`, so a code outside the allow-list has already become the
   * configured fallback. This suite mocks the request/response pair, so
   * `request.locale: "en"` here stands in for what `cacheLocale()` would have
   * resolved an unsupported `?locale=xx` to — the real resolution is core's
   * own proven contract (`core/src/http/response-set-locale.spec.ts`,
   * `request.spec.ts`).
   *
   * DECISION this spec pins down: the handler persists whatever
   * `request.locale` resolved to UNCONDITIONALLY, on every locale-bearing
   * data request — it never reads the incoming cookie back out to compare
   * against it first. Re-persisting an already-current value is a harmless
   * cookie rewrite, and comparing would duplicate the READ side's own job.
   */
  it("persists the validated fallback, not the raw query value, for an unsupported code", async () => {
    const bundle = {
      route: { name: "account", path: "/account", params: {}, query: { locale: "xx" } },
    };

    renderPageRequest.mockResolvedValue({
      html: "",
      status: 200,
      headers: {},
      data: undefined,
      bundle,
    });

    const requestContext = dataRequestContext("/account", undefined, { locale: "xx" }, "en");
    const handler = createPageRouteHandler(
      handlerOptions({ "app.tsx": {}, "composed-layout.tsx": {}, "account.page.tsx": {} }),
    );

    await handler(requestContext as never);

    expect(requestContext.response.setLocale).toHaveBeenCalledWith("en");
  });
});

describe("createPageRouteHandler — Stage 2 slice S3 (NDJSON client navigation)", () => {
  it("awaits and inlines deferred values (never streams) when Accept has no x-ndjson", async () => {
    renderPageRequest.mockResolvedValue({
      html: "",
      status: 200,
      headers: {},
      data: undefined,
      bundle: { route: { name: "dashboard", path: "/dashboard", params: {}, query: {} } },
    });

    const requestContext = dataRequestContext("/dashboard");
    const handler = createPageRouteHandler(
      handlerOptions({ "app.tsx": {}, "composed-layout.tsx": {}, "account.page.tsx": {} }),
    );

    await handler(requestContext as never);

    const [, options] = renderPageRequest.mock.calls[0] as [string, RenderPageRequestOptions];
    expect(options.awaitDeferredForDataRequest).toBe(true);
    expect(writeDeferredNdjsonResponse).not.toHaveBeenCalled();
    expect(requestContext.response.send).toHaveBeenCalled();
  });

  it("streams NDJSON when Accept includes x-ndjson and the page has deferred keys", async () => {
    const bundle = {
      route: { name: "dashboard", path: "/dashboard", params: {}, query: {} },
      deferredKeys: ["reviews"],
      deferredSettlements: { reviews: Promise.resolve({ ok: true, value: 1 }) },
    };
    renderPageRequest.mockResolvedValue({
      html: "",
      status: 200,
      headers: {},
      data: undefined,
      bundle,
    });

    const requestContext = dataRequestContext("/dashboard", "application/x-ndjson, application/json");
    const handler = createPageRouteHandler(
      handlerOptions({ "app.tsx": {}, "composed-layout.tsx": {}, "account.page.tsx": {} }),
    );

    await handler(requestContext as never);

    const [, options] = renderPageRequest.mock.calls[0] as [string, RenderPageRequestOptions];
    expect(options.awaitDeferredForDataRequest).toBe(false);
    expect(writeDeferredNdjsonResponse).toHaveBeenCalledWith(
      requestContext.response,
      bundle,
      "en",
      200,
    );
    expect(requestContext.response.send).not.toHaveBeenCalled();
  });

  it("a page with no defer() is unchanged even when Accept includes x-ndjson", async () => {
    const bundle = { route: { name: "plain", path: "/plain", params: {}, query: {} } };
    renderPageRequest.mockResolvedValue({
      html: "",
      status: 200,
      headers: {},
      data: undefined,
      bundle,
    });

    const requestContext = dataRequestContext("/plain", "application/x-ndjson, application/json");
    const handler = createPageRouteHandler(
      handlerOptions({ "app.tsx": {}, "composed-layout.tsx": {}, "account.page.tsx": {} }),
    );

    await handler(requestContext as never);

    expect(writeDeferredNdjsonResponse).not.toHaveBeenCalled();
    expect(requestContext.response.send).toHaveBeenCalledWith(
      JSON.stringify(buildHydrationPayload(bundle as never, "en")),
      200,
    );
  });
});
