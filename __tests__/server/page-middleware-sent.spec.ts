import { createElement, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpContext } from "@warlock.js/core";
import {
  createPageRouteHandler,
  type PageModuleLoader,
} from "../../src/server/create-page-route-handler";
import { connectPageContext, type PageContextRunner } from "../../src/server/index";
import { connectSharedStore, type SharedStoreResolver } from "../../src/shared";
import { createCoreHttp, requestContext } from "../../src/server/__fixtures__/core-http";
import * as App from "./fixtures/root";

/**
 * A page/layout middleware that ALREADY SENT the reply itself — `pageAuth`'s
 * `response.redirect("/login?return_to=…")`, a `response.forbidden()` — is
 * the whole answer. The handler used to send a second time anyway (the data
 * branch through `sendPageDataResponse`, the document branch through the
 * buffered `response.html("")` fallback), so every logged-out visit to a
 * guarded page logged core's "send() called on already-sent response" error
 * while the 302 itself was correct. Asserted here as: exactly zero further
 * `Response.send` calls, for both representations.
 */

const APP_FILE = "/fixtures/web/root.tsx";
const LAYOUT_FILE = "/fixtures/web/account.layout.tsx";
const PAGE_FILE = "/fixtures/web/settings.page.tsx";
const PAGE_URL = "/account/settings";

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

const guardedLayout = {
  middleware: [({ response }: any) => response.redirect("/login")],
  default: ({ children }: { children?: ReactNode }) => createElement("section", null, children),
};

const settingsPage = {
  loader: async () => ({ never: true }),
  default: () => createElement("main", null, "settings"),
};

async function requestGuardedPage(headers: Record<string, string>) {
  const http = createCoreHttp({ url: PAGE_URL, headers });
  const send = vi.spyOn(http.response, "send");

  const handler = createPageRouteHandler({
    path: PAGE_URL,
    name: "account.settings",
    appFile: APP_FILE,
    pageFile: PAGE_FILE,
    layoutFile: LAYOUT_FILE,
    loadModule: moduleLoader({
      [APP_FILE]: App,
      [LAYOUT_FILE]: guardedLayout,
      [PAGE_FILE]: settingsPage,
    }),
    httpServer: undefined,
  });

  await handler({ request: http.request, response: http.response } as unknown as HttpContext);

  return { reply: http.reply, send };
}

describe("a middleware that already sent the reply is the whole answer", () => {
  it("DOCUMENT request: one redirect, 302 with Location, no second send", async () => {
    const { reply, send } = await requestGuardedPage({ accept: "text/html" });

    expect(reply.redirects).toEqual([{ url: "/login", statusCode: 302 }]);
    expect(reply.statusCode).toBe(302);
    expect(reply.appliedHeaders.location).toBe("/login");
    expect(send).not.toHaveBeenCalled();
    expect(reply.payloads).toEqual([]);
  });

  it("DATA request: one redirect, 302 with Location, no second send", async () => {
    const { reply, send } = await requestGuardedPage({ "x-warlock-data": "1" });

    expect(reply.redirects).toEqual([{ url: "/login", statusCode: 302 }]);
    expect(reply.statusCode).toBe(302);
    expect(reply.appliedHeaders.location).toBe("/login");
    expect(send).not.toHaveBeenCalled();
    expect(reply.payloads).toEqual([]);
  });
});
