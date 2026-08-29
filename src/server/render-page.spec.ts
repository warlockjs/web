import { Response, type Request } from "@warlock.js/core";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PAYLOAD_SCRIPT_ID } from "../components/document-context";

const { resolvePageMetadata } = vi.hoisted(() => ({
  resolvePageMetadata: vi.fn(() => ({ metadata: {} })),
}));

vi.mock("./resolve-page-metadata", async () => {
  const actual = await vi.importActual<typeof import("./resolve-page-metadata")>(
    "./resolve-page-metadata",
  );
  return { ...actual, resolvePageMetadata };
});
vi.mock("../shared", () => ({
  enterSharedScope: vi.fn(),
  sealShared: vi.fn(async () => Object.freeze({})),
}));

import { connectPageContext, type PageRouteEntry } from "./execute-page-request";
import { isNonHydrating } from "./page-render-bundle";
import { renderPage, renderPageFailure } from "./render-page";
import type { ErrorPageModule } from "./error-page";

beforeEach(() => {
  resolvePageMetadata.mockClear();
  connectPageContext({
    buildStore: payload => payload as never,
    getStore: () => undefined,
    run: async (_store, callback) => callback(),
  });
});

/**
 * `renderPage.request`/`.response` mirror what `capturingCreateHttp` needs:
 * `documentSlotsFrom` reads `.nonce`/`.locale`, and `finishRender` reads
 * `.getHeaders`/`.header`/`.statusCode` — the same surface core's real
 * `Response` implements, used here directly (as other server specs do)
 * rather than re-declaring it.
 */
function createHttp() {
  const response = new Response();
  const request = { nonce: undefined, locale: undefined } as unknown as Request;

  return { request, response };
}

function throwingPageEntry(): PageRouteEntry {
  return {
    path: "/boom",
    name: "boom",
    triple: {
      app: {},
      layout: {},
      page: {
        default: () => {
          throw new Error("page render exploded");
        },
      },
    },
  };
}

function fakeErrorPageModule(): ErrorPageModule {
  return {
    default: () => createElement("main", {}, "Sorry about that."),
  };
}

describe("renderPageFailure — pre-triple fallback", () => {
  it("marks the bundle non-hydrating and emits neither the __WARLOCK_DATA__ payload nor its script", async () => {
    const { request, response } = createHttp();

    const rendered = await renderPageFailure({
      name: "boom",
      path: "/boom",
      request,
      response,
      thrown: new Error("module load failed"),
      loadErrorPage: async () => fakeErrorPageModule(),
    });

    expect(isNonHydrating(rendered.bundle)).toBe(true);
    expect(rendered.html).not.toContain(PAYLOAD_SCRIPT_ID);
  });

  it("stays non-hydrating even when it falls all the way back to FrameworkRootBoundary (no app error page configured)", async () => {
    const { request, response } = createHttp();

    const rendered = await renderPageFailure({
      name: "boom",
      path: "/boom",
      request,
      response,
      thrown: new Error("module load failed"),
    });

    expect(isNonHydrating(rendered.bundle)).toBe(true);
    expect(rendered.html).not.toContain(PAYLOAD_SCRIPT_ID);
  });
});

describe("finishRender — normal app error page path", () => {
  it("keeps a normal app error page hydratable: bundle unmarked, __WARLOCK_DATA__ payload present", async () => {
    const entry = throwingPageEntry();
    const { request, response } = createHttp();

    const rendered = await renderPage("boom", {
      routes: [entry],
      createHttp: () => ({ request, response }),
      loadErrorPage: async () => fakeErrorPageModule(),
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    expect(isNonHydrating(rendered.bundle)).toBe(false);
    expect(rendered.html).toContain(PAYLOAD_SCRIPT_ID);
    expect(rendered.bundle?.errorPage).toEqual({
      error: { name: expect.any(String), message: expect.any(String), stack: expect.any(String) },
      status: 500,
    });
  });
});
