import config from "@mongez/config";
import { Request, Response } from "@warlock.js/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared", () => ({
  enterSharedScope: vi.fn(),
  sealShared: vi.fn(async () => Object.freeze({})),
}));

import {
  connectPageContext,
  executePageRequest,
  type PageDataBundle,
  type PageRouteEntry,
} from "./execute-page-request";
import { isStoreEligible } from "./page-cache-eligibility";

const entry: PageRouteEntry = {
  path: "/account",
  name: "account",
  triple: { app: {}, layout: {}, page: { loader: () => ({}) } },
};

function http(): { request: Request; response: Response } {
  const request = { locals: {} as Record<string, unknown>, method: "GET" } as unknown as Request;

  return { request, response: new Response() };
}

async function run(resolver: unknown) {
  const pair = http();

  config.set("web.session", resolver);

  const bundle = (await executePageRequest({
    url: "/account",
    routes: [entry],
    createHttp: () => pair,
  })) as PageDataBundle;

  return { ...pair, bundle };
}

function eligibility(authDerived: boolean | undefined) {
  return isStoreEligible({
    method: "GET",
    authDerived,
    response: { getHeader: () => undefined } as never,
    status: 200,
    crawler: false,
    hasBufferedCookie: false,
  } as never);
}

beforeEach(() => {
  connectPageContext({
    buildStore: (payload) => payload as never,
    getStore: () => undefined,
    run: async (_store, callback) => callback(),
  });
});

afterEach(() => {
  config.set("web.session", undefined);
});

describe("session stage and the page cache", () => {
  it("does not mark a guest render auth-derived, so it stays store-eligible", async () => {
    const { request, bundle } = await run({ resolve: async () => null });

    expect(bundle.session).toEqual({ user: null });
    expect(request.locals.authDerived).not.toBe(true);
    expect(eligibility(false)).toBe(true);
  });

  it("marks a signed-in render auth-derived, so it is never stored", async () => {
    const { request, bundle } = await run({
      resolve: async () => ({ model: { id: 1, password: "x" }, user: { id: 1 } }),
    });

    expect(bundle.session).toEqual({ user: { id: 1 } });
    expect(request.locals.authDerived).toBe(true);
    expect(eligibility(true)).toBe(false);
  });

  it("leaves a page without web.session untouched", async () => {
    const { request, bundle } = await run(undefined);

    expect("session" in bundle).toBe(false);
    expect(request.locals.authDerived).toBeUndefined();
  });
});

describe("PageRedirectSignal through the pipeline", () => {
  it("short-circuits as a 302 redirect and skips lower loaders", async () => {
    const { PageRedirectSignal } = await import("../session/page-redirect-signal");
    const lower = vi.fn();
    const redirecting: PageRouteEntry = {
      path: "/account",
      name: "account",
      triple: {
        app: {},
        layout: {
          loader: () => {
            throw new PageRedirectSignal("/login?redirect=%2Faccount");
          },
        },
        page: { loader: lower },
      },
    };
    const pair = http();

    config.set("web.session", undefined);

    const bundle = (await executePageRequest({
      url: "/account",
      routes: [redirecting],
      createHttp: () => pair,
    })) as PageDataBundle;

    expect(lower).not.toHaveBeenCalled();
    expect(bundle.shortCircuit).toMatchObject({
      stage: "loaders",
      kind: "redirect",
      statusCode: 302,
      url: "/login?redirect=%2Faccount",
    });
    expect(bundle.error).toBeUndefined();
  });
});
