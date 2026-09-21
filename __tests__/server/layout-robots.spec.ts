import { createElement, type ReactNode } from "react";
import { parse } from "devalue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HttpContext } from "@warlock.js/core";
import {
  createPageRouteHandler,
  type PageRouteHandler,
} from "../../src/server/create-page-route-handler";
import { composeLayoutModules } from "../../src/server/compose-layout-modules";
import {
  connectPageContext,
  executePageRequest,
  type PageContextRunner,
  type PageRouteEntry,
} from "../../src/server/index";
import type { LayoutModuleShape } from "../../src/server/page-module-shapes";
import { connectSharedStore, type SharedStoreResolver } from "../../src/shared";
import { createCoreHttp, requestContext } from "../../src/server/__fixtures__/core-http";
import * as App from "./fixtures/root";

/**
 * Request-level regression coverage for inherited layout robots.  The handler
 * is fed the same composed layout module an installer creates: raw layout
 * namespaces flow through `composeLayoutModules`, then the real handler runs
 * `renderPageRequest` and `executePageRequest` for both document and data
 * representations.  No resolver is replaced with a test double.
 */

const APP_FILE = "/robots/root.tsx";
const LAYOUT_FILE = "/robots/inner/layout.tsx";
const PAGE_FILE = "/robots/page.tsx";
const URL = "/robots";

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

type Page = Record<string, unknown>;

function layoutChain(outer: LayoutModuleShape = { metadata: { robots: "noindex" } }) {
  const inner: LayoutModuleShape = {
    default: ({ children }: { children?: ReactNode }) => createElement("main", null, children),
  };

  // Deliberately compose a non-rendering ancestor into its inner rendering
  // host. This is the two-layout installer composition path.
  const raw = [
    {
      config: {
        ...(outer.metadata === undefined ? {} : { metadata: outer.metadata }),
        ...(outer.middleware === undefined ? {} : { middleware: outer.middleware }),
        ...(outer.prefix === undefined ? {} : { prefix: outer.prefix }),
      },
      ...(outer.register === undefined ? {} : { register: outer.register }),
      ...(outer.loader === undefined ? {} : { loader: outer.loader }),
      ...(outer.default === undefined ? {} : { default: outer.default }),
    },
    {
      config: {
        ...(inner.metadata === undefined ? {} : { metadata: inner.metadata }),
        ...(inner.middleware === undefined ? {} : { middleware: inner.middleware }),
        ...(inner.prefix === undefined ? {} : { prefix: inner.prefix }),
      },
      ...(inner.register === undefined ? {} : { register: inner.register }),
      ...(inner.loader === undefined ? {} : { loader: inner.loader }),
      ...(inner.default === undefined ? {} : { default: inner.default }),
    },
  ] as const;

  return { raw, composed: composeLayoutModules([outer, inner], 1) };
}

function handlerFor(page: Page, outer?: LayoutModuleShape): PageRouteHandler {
  const layouts = layoutChain(outer);
  const rawPage = {
    config: {
      ...(page.metadata === undefined ? {} : { metadata: page.metadata }),
      ...(page.middleware === undefined ? {} : { middleware: page.middleware }),
    },
    default: page.default,
  };
  const rawApp = {
    config: { middleware: App.config.middleware },
    loader: App.loader,
    default: App.default,
  };
  const modules: Record<string, unknown> = {
    [APP_FILE]: rawApp,
    [PAGE_FILE]: rawPage,
  };

  return createPageRouteHandler({
    path: URL,
    name: "robots.page",
    appFile: APP_FILE,
    layoutFile: LAYOUT_FILE,
    pageFile: PAGE_FILE,
    loadModule: async (id) => modules[id],
    loadComposedLayout: async () => layouts.composed,
    // The production registration surface keeps the raw namespaces; only the
    // request pipeline receives the synthetic composed host.
    loadRegistrationLayouts: async () => layouts.raw,
    httpServer: undefined,
  });
}

async function wire(
  handler: PageRouteHandler,
  headers: Record<string, string> = { accept: "text/html" },
) {
  const http = createCoreHttp({ url: URL, headers });
  const chunks: Buffer[] = [];
  http.reply.raw.on("data", (chunk: Buffer) => chunks.push(chunk));

  await handler({ request: http.request, response: http.response } as unknown as HttpContext);

  return {
    body:
      Buffer.concat(chunks).toString("utf8") +
      http.reply.payloads
        .filter((payload): payload is string => typeof payload === "string")
        .join(""),
    status: http.reply.statusCode,
  };
}

function page(metadata?: unknown): Page {
  return {
    ...(metadata === undefined ? {} : { metadata }),
    default: () => createElement("p", null, "robots page"),
  };
}

function pipeline(pageModule: Page, outer?: LayoutModuleShape) {
  const { composed } = layoutChain(outer);
  const entry: PageRouteEntry = {
    path: URL,
    name: "robots.page",
    triple: { app: App as never, layout: composed as never, page: pageModule as never },
  };

  return executePageRequest({
    url: URL,
    routes: [entry],
    createHttp: (match) => createCoreHttp({ url: URL, params: match.params, query: match.query }),
  });
}

describe("inherited layout robots at the request boundary", () => {
  it.each([
    ["no page metadata", undefined],
    ["title-only static metadata", { title: "Robots" }],
    ["title-only metadata function", () => ({ title: "Robots" })],
  ])(
    "inherits noindex through the composed two-layout pipeline with %s",
    async (_case, metadata) => {
      const bundle = await pipeline(page(metadata));

      expect(bundle).toMatchObject({ metadata: { robots: "noindex" } });
    },
  );

  it("preserves host loader data and robots through a true one-layout composition", async () => {
    let loaderCalls = 0;
    const hostData = { navigation: ["home"], source: "single-layout" };
    const single: LayoutModuleShape = {
      default: ({ children }: { children?: ReactNode }) => createElement("main", null, children),
      metadata: { robots: "noindex" },
      loader: async () => {
        loaderCalls += 1;
        return hostData;
      },
    };
    const composed = composeLayoutModules([single], 0, ["/robots/layout.tsx"]);
    const entry: PageRouteEntry = {
      path: URL,
      name: "robots.single-layout",
      triple: {
        app: App as never,
        layout: composed as never,
        page: page({ title: "Robots" }) as never,
      },
    };

    const bundle = await executePageRequest({
      url: URL,
      routes: [entry],
      createHttp: (match) => createCoreHttp({ url: URL, params: match.params, query: match.query }),
    });

    expect(bundle).toMatchObject({
      layoutData: hostData,
      metadata: { title: "Robots", robots: "noindex" },
    });
    expect(loaderCalls).toBe(1);
  });

  it("lets an explicit page robots directive override the non-rendering ancestor", async () => {
    const bundle = await pipeline(page({ title: "Public", robots: "index,follow" }));

    expect(bundle).toMatchObject({ metadata: { title: "Public", robots: "index,follow" } });
  });

  it("uses error noindex when an ancestor loader fails or page metadata throws", async () => {
    const loaderFailure = await pipeline(page(), {
      metadata: { robots: "index,follow" },
      loader: async () => {
        throw new Error("ancestor failed");
      },
    });
    const metadataFailure = await pipeline(
      page(() => {
        throw new Error("metadata failed");
      }),
    );

    expect(loaderFailure).toMatchObject({
      error: expect.anything(),
      metadata: { robots: "noindex" },
    });
    expect(metadataFailure).toMatchObject({
      error: expect.anything(),
      metadata: { robots: "noindex" },
    });
  });

  it("does not render a document after a middleware short-circuit", async () => {
    const guarded = { ...page(), middleware: [async () => ({ denied: true })] };
    const result = await wire(handlerFor(guarded));

    expect(result.status).toBe(200);
    expect(result.body).toBe('{"denied":true}');
    expect(result.body.toLowerCase()).not.toContain("<!doctype html>");
  });

  it("keeps SSR head metadata and client-navigation metadata identical", async () => {
    const route = handlerFor(page({ title: "Inherited", description: "same payload" }));
    const document = await wire(route);
    const navigation = await wire(route, { "x-warlock-data": "1" });
    const payload = parse(navigation.body) as { metadata?: Record<string, unknown> };

    expect(document.body).toMatch(/<meta name="robots" content="noindex"\s*\/?>/);
    expect(payload.metadata).toEqual({
      title: "Inherited",
      description: "same payload",
      robots: "noindex",
    });
  });
});
