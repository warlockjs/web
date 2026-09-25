import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { setEnvironment } from "@warlock.js/core";
import type { Response } from "@warlock.js/core";
import { defaultApplyBufferedCookie } from "./create-page-route-handler";
import {
  buildErrorRecord,
  commitBuffers,
  createActionResponse,
  createLevelBuffer,
  isActionFailure,
  isLoaderShortCircuit,
} from "./settle-page-response";
import { PublicPageError } from "./public-page-error";
import type { PageBoundaryDesignation } from "./execute-page-request.types";

const boundary: PageBoundaryDesignation = { throwingLevel: "page", boundaryLevel: "page" };
const originalNodeEnv = process.env.NODE_ENV;

describe("buildErrorRecord()", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("scrubs an unexpected loader error's message in production, keeping the original for the error page's own SSR", () => {
    setEnvironment("production");
    const thrown = new Error("db password=hunter2");

    const record = buildErrorRecord(thrown, boundary);

    expect(record.scrubbed).toBe(true);
    expect((record.error as Error).message).not.toContain("hunter2");
    expect((record.error as Error).message).toBe("An unexpected error occurred.");
    expect(record.originalError).toBe(thrown);
  });

  it("passes a PublicPageError's own message through untouched in production", () => {
    setEnvironment("production");
    const thrown = new PublicPageError("This slug is already taken.");

    const record = buildErrorRecord(thrown, boundary);

    expect(record.error).toBe(thrown);
    expect((record.error as Error).message).toBe("This slug is already taken.");
    expect(record.scrubbed).toBe(false);
  });

  it("keeps the real error in development", () => {
    setEnvironment("development");
    const thrown = new Error("db password=hunter2");

    const record = buildErrorRecord(thrown, boundary);

    expect(record.error).toBe(thrown);
    expect(record.scrubbed).toBe(false);
  });
});

describe("createActionResponse()", () => {
  it.each([
    ["badRequest", 400],
    ["unauthorized", 401],
    ["forbidden", 403],
    ["conflict", 409],
    ["unprocessableEntity", 422],
    ["tooManyRequests", 429],
    ["serviceUnavailable", 503],
  ] as const)("%s returns a branded %i failure signal and buffers the status", (helper, status) => {
    const buffer = createLevelBuffer();
    const signal = createActionResponse(buffer)[helper]({ message: "no" });

    expect(isActionFailure(signal)).toBe(true);
    expect(isLoaderShortCircuit(signal)).toBe(false);
    expect(signal).toMatchObject({ statusCode: status, helper, payload: { message: "no" } });
    expect(buffer.statusCode).toBe(status);
  });

  it("keeps the buffered response surface and never brands lookalike objects", () => {
    const buffer = createLevelBuffer();
    const response = createActionResponse(buffer);

    expect(isLoaderShortCircuit(response.redirect("/x"))).toBe(true);
    expect(isActionFailure({ kind: "failure", statusCode: 400 })).toBe(false);
  });
});

describe("clearCookie() on a buffered response", () => {
  function fakeResponse() {
    return {
      header: vi.fn(),
      setStatusCode: vi.fn(),
      cookie: vi.fn(),
      clearCookie: vi.fn(),
    };
  }

  it("queues a deletion that replays through response.clearCookie()", () => {
    const buffer = createLevelBuffer();
    createActionResponse(buffer).clearCookie("refresh_token", { path: "/" });

    const real = fakeResponse();
    for (const cookie of buffer.cookies) {
      defaultApplyBufferedCookie(real as unknown as Response, cookie);
    }

    expect(real.clearCookie).toHaveBeenCalledWith("refresh_token", { path: "/" });
    expect(real.cookie).not.toHaveBeenCalled();
  });

  it("lets the last write per name win across set and clear", () => {
    const app = createLevelBuffer();
    const page = createLevelBuffer();
    createActionResponse(app).cookie("access_token", "abc", { raw: true });
    createActionResponse(page).clearCookie("access_token", { path: "/" });

    const commit = commitBuffers(
      fakeResponse() as unknown as Response,
      { app, layout: createLevelBuffer(), page },
      ["app", "layout", "page"],
    );

    expect(commit.cookies).toEqual([
      { name: "access_token", value: "", options: { path: "/" }, clear: true },
    ]);
  });

  it("satisfies the cookie-writer shape @warlock.js/auth's session helpers take", () => {
    // A structural copy of auth's `CookieWriter`; web does not depend on auth.
    type CookieWriter = {
      cookie(name: string, value: string, options?: Record<string, unknown>): unknown;
      clearCookie(name: string, options?: Record<string, unknown>): unknown;
    };

    expectTypeOf(createActionResponse(createLevelBuffer())).toMatchTypeOf<CookieWriter>();
  });
});
