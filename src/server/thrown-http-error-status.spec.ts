/**
 * Card f2b8953d — a core `@warlock.js/core` `HttpError` thrown inside a page
 * (or app/layout) loader used to be read as `(thrown as
 * {statusCode}).statusCode`, which is always `undefined` for a core error
 * (it carries `status`, not `statusCode`) — so every core `HttpError` was
 * treated as a plain 500. `resolveThrownHttpStatus` fixes the read; these
 * specs prove the three required outcomes: a resolved 404 takes the exact
 * SAME loader short-circuit path `response.notFound()` already takes, any
 * other 4xx renders `error.page.tsx` with its own status and its own
 * (visitor-safe) message even in production, and a 4xx is never reported
 * through `web.errors.report()`/the stderr floor while a 5xx still is.
 */
import config from "@mongez/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BadRequestError,
  ForbiddenError,
  Request,
  Response,
  ResourceNotFoundError,
  ServerError,
  setEnvironment,
} from "@warlock.js/core";
import {
  connectPageContext,
  executePageRequest,
  type PageContextRunner,
  type PageRouteEntry,
} from "./execute-page-request";
import { renderPageRequest } from "./render-page";
import { GENERIC_PRODUCTION_ERROR_MESSAGE, serializePageError } from "./error-page";
import { resetServerErrorReportingStateForTests } from "./report-server-error";

const originalNodeEnv = process.env.NODE_ENV;

function restoreEnvironment(): void {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
}

let previousRunner: PageContextRunner | undefined;

beforeEach(() => {
  previousRunner = connectPageContext({
    buildStore: (payload) => payload as never,
    getStore: () => undefined,
    run: async (_store, callback) => callback(),
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  resetServerErrorReportingStateForTests();
});

afterEach(() => {
  connectPageContext(previousRunner);
  vi.restoreAllMocks();
  resetServerErrorReportingStateForTests();
  config.set("web", {});
  restoreEnvironment();
});

/** A minimal request the pipeline needs nothing else from for these loader-throw specs. */
function fakeRequest(): Request {
  return { setValidatedData: () => undefined } as unknown as Request;
}

function entryWithThrowingLoader(path: string, loader: () => never): PageRouteEntry {
  return {
    path,
    name: path.replace("/", ""),
    triple: { app: {}, layout: {}, page: { loader } },
  };
}

describe("card f2b8953d — a thrown core HttpError resolves to its own status", () => {
  it("ResourceNotFoundError produces the exact same loader short-circuit shape response.notFound() produces", async () => {
    const explicitEntry: PageRouteEntry = {
      path: "/explicit",
      name: "explicit",
      triple: {
        app: {},
        layout: {},
        page: { loader: ({ response }) => response.notFound() },
      },
    };
    const thrownEntry = entryWithThrowingLoader("/thrown", () => {
      throw new ResourceNotFoundError("account not found");
    });

    const explicitBundle = await executePageRequest({
      url: "/explicit",
      routes: [explicitEntry],
      createHttp: () => ({ request: fakeRequest(), response: new Response() }),
    });
    const thrownBundle = await executePageRequest({
      url: "/thrown",
      routes: [thrownEntry],
      createHttp: () => ({ request: fakeRequest(), response: new Response() }),
    });

    if (
      explicitBundle instanceof Response ||
      thrownBundle instanceof Response ||
      explicitBundle === undefined ||
      thrownBundle === undefined
    ) {
      throw new Error("unexpected terminal Response");
    }

    expect(thrownBundle.shortCircuit).toEqual({
      stage: "loaders",
      level: "page",
      kind: "notFound",
      statusCode: 404,
      url: undefined,
      body: undefined,
    });
    // Never a parallel implementation: the resolved-404 shape and the
    // explicit response.notFound() shape are byte-identical, level aside.
    expect(thrownBundle.shortCircuit).toEqual(explicitBundle.shortCircuit);
    expect(thrownBundle.error).toBeUndefined();
  });

  it("BadRequestError resolves bundle.error with statusCode 400, no short-circuit", async () => {
    const entry = entryWithThrowingLoader("/bad", () => {
      throw new BadRequestError("Missing field: email.");
    });

    const bundle = await executePageRequest({
      url: "/bad",
      routes: [entry],
      createHttp: () => ({ request: fakeRequest(), response: new Response() }),
    });

    if (bundle instanceof Response || bundle === undefined)
      throw new Error("unexpected terminal Response");

    expect(bundle.shortCircuit).toBeUndefined();
    expect(bundle.error?.statusCode).toBe(400);
  });

  it("ForbiddenError resolves status 403 and keeps its own message even in production (PublicPageError treatment)", async () => {
    setEnvironment("production");
    const entry = entryWithThrowingLoader("/forbidden", () => {
      throw new ForbiddenError("Members only.");
    });

    const bundle = await executePageRequest({
      url: "/forbidden",
      routes: [entry],
      createHttp: () => ({ request: fakeRequest(), response: new Response() }),
    });

    if (bundle instanceof Response || bundle === undefined)
      throw new Error("unexpected terminal Response");

    expect(bundle.error?.statusCode).toBe(403);
    expect(bundle.error?.scrubbed).toBe(false);

    const serialized = serializePageError(bundle.error?.error);
    expect(serialized.message).toBe("Members only.");
  });

  it("ServerError resolves status 500 and the generic scrubbed message in production", async () => {
    setEnvironment("production");
    const entry = entryWithThrowingLoader("/boom", () => {
      throw new ServerError("db connection refused at 10.0.0.4");
    });

    const bundle = await executePageRequest({
      url: "/boom",
      routes: [entry],
      createHttp: () => ({ request: fakeRequest(), response: new Response() }),
    });

    if (bundle instanceof Response || bundle === undefined)
      throw new Error("unexpected terminal Response");

    expect(bundle.error?.statusCode).toBe(500);
    expect(bundle.error?.scrubbed).toBe(true);

    const serialized = serializePageError(bundle.error?.error);
    expect(serialized.message).toBe(GENERIC_PRODUCTION_ERROR_MESSAGE);
    expect(serialized.message).not.toContain("10.0.0.4");
  });

  it("a resolved 4xx is never reported through web.errors.report(); a resolved 5xx still is", async () => {
    const report = vi.fn();
    config.set("web", { errors: { report } });

    const forbiddenEntry = entryWithThrowingLoader("/forbidden", () => {
      throw new ForbiddenError("nope");
    });
    const serverErrorEntry = entryWithThrowingLoader("/boom", () => {
      throw new ServerError("db down");
    });

    await executePageRequest({
      url: "/forbidden",
      routes: [forbiddenEntry],
      createHttp: () => ({ request: fakeRequest(), response: new Response() }),
    });
    await Promise.resolve();
    expect(report).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();

    await executePageRequest({
      url: "/boom",
      routes: [serverErrorEntry],
      createHttp: () => ({ request: fakeRequest(), response: new Response() }),
    });
    await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalled();
  });

  it("the data-wire (JSON) request settles on the exact same resolved status as the document request", async () => {
    const forbiddenEntry = entryWithThrowingLoader("/forbidden", () => {
      throw new ForbiddenError("nope");
    });
    const notFoundEntry = entryWithThrowingLoader("/missing", () => {
      throw new ResourceNotFoundError("missing");
    });

    const forbiddenRendered = await renderPageRequest("/forbidden", {
      routes: [forbiddenEntry],
      createHttp: () => ({ request: fakeRequest(), response: new Response() }),
      dataRequest: true,
    });
    const notFoundRendered = await renderPageRequest("/missing", {
      routes: [notFoundEntry],
      createHttp: () => ({ request: fakeRequest(), response: new Response() }),
      dataRequest: true,
    });

    if (forbiddenRendered instanceof Response || notFoundRendered instanceof Response) {
      throw new Error("unexpected terminal Response");
    }

    expect(forbiddenRendered.status).toBe(403);
    expect(notFoundRendered.status).toBe(404);
  });
});
