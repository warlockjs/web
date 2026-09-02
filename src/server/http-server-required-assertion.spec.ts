/**
 * The assertion `create-page-route-handler.ts` raises when it cannot tell
 * whether the missing `httpServer` option is deliberate. Covers exactly the
 * three cases the ruling calls out: the throw, its message, and the escape
 * hatch — kept separate from `create-page-route-handler.spec.ts` (which
 * assumes `httpServer: undefined` throughout, per its `handlerOptions`
 * helper) so the assertion's own contract has a home that does not depend on
 * that helper's default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { container } from "@warlock.js/core";

const { renderPageRequest } = vi.hoisted(() => ({
  renderPageRequest: vi.fn(),
}));

vi.mock("./render-page", () => ({ renderPageRequest }));

import {
  createPageRouteHandler,
  MissingHttpServerForPageRouteError,
  type PageRouteHandlerOptions,
} from "./create-page-route-handler";

function baseOptions(): Omit<PageRouteHandlerOptions, "httpServer"> {
  return {
    path: "/account",
    name: "account",
    appFile: "app.tsx",
    layoutFile: "layout.tsx",
    pageFile: "page.tsx",
    loadModule: async () => ({}),
  };
}

describe("createPageRouteHandler — httpServer assertion", () => {
  beforeEach(() => {
    renderPageRequest.mockReset();
  });

  afterEach(() => {
    container.delete("http.server");
  });

  it("throws, naming the container key, when httpServer is not supplied and the container has no http.server binding", () => {
    expect(() => createPageRouteHandler(baseOptions())).toThrowError(
      MissingHttpServerForPageRouteError,
    );

    expect(() => createPageRouteHandler(baseOptions())).toThrow(/"http\.server"/);
  });

  it("does NOT throw when httpServer is supplied as undefined explicitly — the deliberate no-server escape hatch", () => {
    expect(() => createPageRouteHandler({ ...baseOptions(), httpServer: undefined })).not.toThrow();
  });

  it("does NOT throw when httpServer is not supplied but the container has an http.server binding", () => {
    container.set("http.server", { addHook: vi.fn() } as never);

    expect(() => createPageRouteHandler(baseOptions())).not.toThrow();
  });
});
