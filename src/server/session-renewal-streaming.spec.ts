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
  type PageRouteEntry,
} from "./execute-page-request";
import { SessionResolvedTooLateError } from "../session/session-resolved-too-late-error";

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

describe("session stage ordering (renewal before headers)", () => {
  it("hands one resolved session to app, layout, and page loaders after resolution", async () => {
    const order: string[] = [];
    const sessions: unknown[] = [];
    const resolve = vi.fn(async () => {
      order.push("resolve");
      return { model: { id: 1 }, user: { id: 1 } };
    });
    const entry: PageRouteEntry = {
      path: "/a",
      name: "a",
      triple: {
        app: {
          loader: (ctx) => {
            sessions.push(ctx.session);
            order.push(`app:${ctx.session?.user?.id}`);
          },
        },
        layout: {
          loader: (ctx) => {
            sessions.push(ctx.session);
            order.push(`layout:${ctx.session?.user?.id}`);
          },
        },
        page: {
          loader: (ctx) => {
            sessions.push(ctx.session);
            order.push(`page:${ctx.session?.user?.id}`);
          },
        },
      },
    };
    const request = { locals: {}, method: "GET" } as unknown as Request;

    config.set("web.session", { resolve });

    await executePageRequest({
      url: "/a",
      routes: [entry],
      createHttp: () => ({ request, response: new Response() }),
      finish: (bundle) => {
        order.push("finish");
        return bundle;
      },
    });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["resolve", "app:1", "layout:1", "page:1", "finish"]);
    expect(sessions).toEqual([
      { user: { id: 1 }, model: { id: 1 } },
      { user: { id: 1 }, model: { id: 1 } },
      { user: { id: 1 }, model: { id: 1 } },
    ]);
    expect(sessions[1]).toBe(sessions[0]);
    expect(sessions[2]).toBe(sessions[0]);
  });

  it("lets the resolver write a renewal cookie onto the response before loaders start", async () => {
    const response = new Response();
    const cookie = vi.spyOn(response, "cookie").mockReturnValue(response as never);
    let loaderSawCookie = false;
    const entry: PageRouteEntry = {
      path: "/a",
      name: "a",
      triple: {
        app: {},
        layout: {},
        page: {
          loader: () => {
            loaderSawCookie = cookie.mock.calls.length > 0;
          },
        },
      },
    };

    config.set("web.session", {
      resolve: async (_request: Request, res: Response) => {
        res.cookie("token", "renewed");
        return { model: {}, user: { id: 1 } };
      },
    });

    await executePageRequest({
      url: "/a",
      routes: [entry],
      createHttp: () => ({
        request: { locals: {}, method: "GET" } as unknown as Request,
        response,
      }),
    });

    expect(loaderSawCookie).toBe(true);
  });

  it("does not invoke a renewal-capable resolver after response headers commit", async () => {
    const resolve = vi.fn(async () => ({ model: { id: 1 }, user: { id: 1 } }));
    const response = new Response();
    (response as unknown as { baseResponse: { raw: { headersSent: boolean } } }).baseResponse = {
      raw: { headersSent: true },
    };

    config.set("web.session", { resolve });

    const result = await executePageRequest({
      url: "/a",
      routes: [
        {
          path: "/a",
          name: "a",
          triple: { app: {}, layout: {}, page: {} },
        },
      ],
      createHttp: () => ({
        request: { locals: {}, method: "GET" } as unknown as Request,
        response,
      }),
    });

    expect(resolve).not.toHaveBeenCalled();
    expect((result as { error?: { error: unknown } }).error?.error).toBeInstanceOf(
      SessionResolvedTooLateError,
    );
  });
});
