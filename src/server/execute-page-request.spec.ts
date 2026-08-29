import { Request, Response } from "@warlock.js/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolvePageMetadata } = vi.hoisted(() => ({
  resolvePageMetadata: vi.fn(() => ({ metadata: {} })),
}));

vi.mock("./resolve-page-metadata", () => ({ resolvePageMetadata }));
vi.mock("../shared", () => ({
  enterSharedScope: vi.fn(),
  sealShared: vi.fn(async () => Object.freeze({})),
}));

import {
  connectPageContext,
  executePageRequest,
  type PageRouteEntry,
} from "./execute-page-request";

const request = {
  setValidatedData: vi.fn(),
} as unknown as Request;

function route(
  loaders: Partial<Record<"app" | "layout" | "page", PageRouteEntry["triple"]["app"]["loader"]>>,
): PageRouteEntry {
  return {
    path: "/account",
    name: "account",
    triple: {
      app: { loader: loaders.app },
      layout: { loader: loaders.layout },
      page: { loader: loaders.page },
    },
  };
}

beforeEach(() => {
  resolvePageMetadata.mockClear();
  connectPageContext({
    buildStore: payload => payload as never,
    getStore: () => undefined,
    run: async (_store, callback) => callback(),
  });
});

describe("executePageRequest loaders", () => {
  // Loaders run in PARALLEL (stage 6 rewrite, request-lifecycle.md) — a
  // returned core `Response` instance is still honoured (rare/legacy: a
  // loader answering the request directly rather than through the buffered
  // short-circuit surface), but "stops before lower loaders" no longer holds
  // under a parallel model. Every level still runs; whichever settled value is
  // a `Response` wins, closest to the root on a tie.
  it("preserves a returned core Response over ordinary sibling data, and never reaches finish", async () => {
    const calls: string[] = [];
    const terminal = new Response();
    const finish = vi.fn();
    const entry = route({
      app: () => calls.push("app"),
      layout: () => {
        calls.push("layout");
        return terminal;
      },
      page: () => calls.push("page"),
    });

    const result = await executePageRequest({
      url: "/account",
      routes: [entry],
      createHttp: () => ({ request, response: terminal }),
      finish,
    });

    expect(result).toBe(terminal);
    expect(calls).toEqual(["app", "layout", "page"]);
    expect(resolvePageMetadata).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it("runs ordinary loader values and keeps them as data", async () => {
    const calls: string[] = [];
    const response = new Response();
    const entry = route({
      app: async () => {
        calls.push("app");
        return { app: true };
      },
      layout: () => {
        calls.push("layout");
        return 0;
      },
      page: () => {
        calls.push("page");
        return false;
      },
    });

    const result = await executePageRequest({
      url: "/account",
      routes: [entry],
      createHttp: () => ({ request, response }),
    });

    expect(calls).toEqual(["app", "layout", "page"]);
    expect(result).toMatchObject({
      appData: { app: true },
      layoutData: 0,
      pageData: false,
    });
  });
});
