import { beforeEach, describe, expect, it, vi } from "vitest";
import { Response } from "@warlock.js/core";

const { renderPageRequest, renderPageFailure } = vi.hoisted(() => ({
  renderPageRequest: vi.fn(),
  renderPageFailure: vi.fn(),
}));

vi.mock("./render-page", () => ({ renderPageRequest, renderPageFailure }));

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

function context(path = "/account") {
  return {
    request: {
      path,
      header: vi.fn(() => undefined),
    },
    response: {
      headers: vi.fn(),
      html: vi.fn(async () => undefined),
    },
  };
}

/**
 * A request carrying the data-request marker, with the response mocks the
 * `wantsData` branches actually call: `header` (singular — `Vary`),
 * `setContentType` and `send`. `context()`'s `response.html` stays present so
 * a wrongly-taken document path is still visible as a spurious call.
 */
function dataRequestContext(path = "/account") {
  const requestContext = context(path);

  return {
    request: {
      ...requestContext.request,
      header: vi.fn((name: string) =>
        name === WARLOCK_DATA_REQUEST_HEADER ? WARLOCK_DATA_REQUEST_VALUE : undefined,
      ),
    },
    response: {
      ...requestContext.response,
      header: vi.fn(),
      setContentType: vi.fn(),
      send: vi.fn(async () => undefined),
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
    loadModule: async moduleId => moduleById[moduleId],
    ...overrides,
  };
}

beforeEach(() => {
  renderPageRequest.mockReset();
  renderPageRequest.mockResolvedValue(renderedOk());
  renderPageFailure.mockReset();
});

describe("createPageRouteHandler — universal registration", () => {
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
    const responseContext = context("/missing/path");
    const handler = createPageRouteHandler(
      handlerOptions(
        {
          "app.tsx": { register: () => calls.push("app") },
          "404.page.tsx": { register: () => calls.push("404"), loader },
        },
        {
          path: "*",
          name: "warlock.not-found",
          layoutFile: undefined,
          pageFile: "404.page.tsx",
          matchPath: requestPath => requestPath,
          statusForRenderedOk: 404,
          skipPageLoader: true,
        },
      ),
    );

    renderPageRequest.mockImplementation(async (_url: string, options: RenderPageRequestOptions) => {
      calls.push("render");
      expect(options.routes?.[0]?.path).toBe("/missing/path");
      expect(options.routes?.[0]?.triple.page.loader).toBeUndefined();
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

    renderPageRequest.mockImplementation(async (_url: string, options: RenderPageRequestOptions) => {
      expect(options.routes?.[0]?.triple.page.loader).toBe(loader);
      return renderedOk();
    });

    await handler(context() as never);
  });
});

describe("createPageRouteHandler — hydration module injection", () => {
  it("injects the hydration client module on an ordinary render", async () => {
    renderPageRequest.mockResolvedValue({
      html: "<html><body></body></html>",
      status: 200,
      headers: {},
      data: undefined,
      bundle: { route: { name: "account", path: "/account", params: {}, query: {} } },
    });

    const requestContext = context();
    const handler = createPageRouteHandler(
      handlerOptions(
        { "app.tsx": {}, "composed-layout.tsx": {}, "account.page.tsx": {} },
        { hydrationClientModuleUrl: "/hydrate.js" },
      ),
    );

    await handler(requestContext as never);

    expect(requestContext.response.html).toHaveBeenCalledWith(
      expect.stringContaining('<script type="module" src="/hydrate.js"></script>'),
      200,
    );
  });

  it("does NOT inject the hydration client module on renderPageFailure's pre-triple fallback", async () => {
    renderPageFailure.mockResolvedValue({
      html: "<html><body></body></html>",
      status: 500,
      headers: {},
      data: undefined,
      bundle: markNonHydrating({ route: { name: "account", path: "/account", params: {}, query: {} } }),
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
        { hydrationClientModuleUrl: "/hydrate.js" },
      ),
    );

    await handler(requestContext as never);

    expect(renderPageFailure).toHaveBeenCalled();
    // Exact match, not just `not.toContain`: proves the fallback's html is
    // returned byte-for-byte, with no `installHydrationClientModule` splice
    // at all — not merely one that happened to omit this particular URL.
    expect(requestContext.response.html).toHaveBeenCalledWith("<html><body></body></html>", 500);
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
    expect(requestContext.response.setContentType).toHaveBeenCalledWith(
      DATA_RESPONSE_CONTENT_TYPE,
    );
    // Serialized with the SAME transform the document embeds under
    // `#__WARLOCK_DATA__`, and sent as the already-stringified body the
    // production code documents at its call site — a JSON.stringify of an
    // object body here would silently change the wire format.
    expect(requestContext.response.send).toHaveBeenCalledWith(
      JSON.stringify(buildHydrationPayload(bundle as never)),
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
    expect(requestContext.response.setContentType).toHaveBeenCalledWith(
      DATA_RESPONSE_CONTENT_TYPE,
    );
    // `markNonHydrating` is what makes the DOCUMENT branch skip splicing the
    // hydration client module (asserted above, in the non-data test) — it
    // says "there is no triple for a browser script to attach to". It says
    // nothing about the DATA branch: there is no script tag to omit here in
    // the first place, only a JSON body, and the catch handler sends the full
    // payload regardless of the bundle's hydration flag. Suppressing it too
    // would be a second, undocumented meaning smuggled onto the same flag.
    expect(requestContext.response.send).toHaveBeenCalledWith(
      JSON.stringify(buildHydrationPayload(bundle as never)),
      500,
    );
    expect(requestContext.response.html).not.toHaveBeenCalled();
  });
});
