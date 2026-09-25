/**
 * Page actions over a REAL Fastify instance and the REAL page pipeline
 * (5.21, design section 6 specs 3-13): the POST route that `mode: "action"`
 * builds, stage 5b, the outcome mapping (303 / 204 / 422) and the always-on
 * Origin guard. Nothing about rendering is mocked: modules are plain
 * namespaces handed to `createPageRouteHandler` through `loadModule`, and
 * `server.inject()` exercises the router on an in-memory instance that never
 * binds a port (same pattern as `page-route-cache-opt-in.spec.ts`).
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { registerHttpPlugins, router, setConfig, type Request } from "@warlock.js/core";
import { v } from "@warlock.js/seal";
import { parse } from "devalue";
import Fastify, { type FastifyInstance } from "fastify";
import { createElement } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import DefaultApp from "../components/default-app";
import { PAYLOAD_SCRIPT_ID } from "../components/document-context";
import { defer } from "../loaders/defer";
import { WARLOCK_DATA_REQUEST_HEADER, WARLOCK_DATA_REQUEST_VALUE } from "../routing/data-request";
import type { PageCacheOptIn } from "../routing/route-identity";
import { createPageRouteHandler } from "./create-page-route-handler";
import { connectPageContext } from "./execute-page-request";
import type { PipelineStore } from "./execute-page-request.types";
import { resetPageCacheDriverStateForTests } from "./page-cache-driver";
import { NDJSON_CONTENT_TYPE } from "./write-deferred-ndjson-response";

const { fakeCache, fakeCacheStore } = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const tagged = () => ({
    async set(key: string, value: unknown) {
      store.set(key, value);
    },
    async get(key: string) {
      return store.has(key) ? store.get(key) : null;
    },
    async invalidate() {},
  });
  const cacheFake: Record<string, unknown> = {
    async get(key: string) {
      return store.has(key) ? store.get(key) : null;
    },
    tags: () => tagged(),
  };

  cacheFake.currentDriver = new (class FakePageCacheDriver {
    public name: string | undefined = "memory";
    public options: Record<string, unknown> = {};

    public setOptions(options: Record<string, unknown>) {
      this.options = options;
      return this;
    }

    public async connect() {}

    public async disconnect() {}

    public get(key: string) {
      return (cacheFake.get as (key: string) => unknown)(key);
    }

    public tags() {
      return tagged();
    }
  })();

  return { fakeCache: cacheFake, fakeCacheStore: store };
});

// Same fake-driver technique as page-server-cache.spec.ts: only
// `cache.currentDriver` is replaced, in place; rendering stays real.
vi.mock("@warlock.js/cache", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  (actual.cache as Record<string, unknown>).currentDriver = fakeCache.currentDriver;

  return actual;
});

vi.mock("../shared", () => ({
  enterSharedScope: vi.fn(),
  sealShared: vi.fn(async () => Object.freeze({})),
}));

const SAME_ORIGIN = "http://localhost";
const FORM_HEADERS = {
  "content-type": "application/x-www-form-urlencoded",
  origin: SAME_ORIGIN,
};
const DATA_HEADERS = {
  ...FORM_HEADERS,
  [WARLOCK_DATA_REQUEST_HEADER]: WARLOCK_DATA_REQUEST_VALUE,
};

type ActionContext = { request: Request; response: any };
type TestPageModule = Record<string, unknown>;

const modules = new Map<string, unknown>();
let loaderCalls = 0;
let actionCalls = 0;
let sessionSeenByMiddleware: number | undefined;

const MULTIPART_BOUNDARY = "----warlockboundary";

/** One multipart body carrying a single file field. */
function multipartFile(field: string, filename: string, mimetype: string, content: string) {
  return {
    headers: {
      "content-type": `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
      origin: SAME_ORIGIN,
      [WARLOCK_DATA_REQUEST_HEADER]: WARLOCK_DATA_REQUEST_VALUE,
    },
    payload: [
      `--${MULTIPART_BOUNDARY}`,
      `Content-Disposition: form-data; name="${field}"; filename="${filename}"`,
      `Content-Type: ${mimetype}`,
      "",
      content,
      `--${MULTIPART_BOUNDARY}--`,
      "",
    ].join("\r\n"),
  };
}

const Page = () => createElement("main", null, "page");

/** A page module, with the counters every spec reads. */
function pageModule(overrides: TestPageModule = {}): TestPageModule {
  return {
    default: Page,
    loader: () => ({ n: ++loaderCalls }),
    ...overrides,
  };
}

function mountPage(
  server: FastifyInstance,
  path: string,
  page: TestPageModule,
  options: { withAction?: boolean; cache?: PageCacheOptIn; layout?: TestPageModule } = {},
): void {
  const pageFile = `page:${path}`;
  const layoutFile = options.layout ? `layout:${path}` : undefined;

  modules.set("app.tsx", { config: {}, default: DefaultApp });
  modules.set(pageFile, page);
  if (layoutFile) modules.set(layoutFile, options.layout);

  const handlerOptions = {
    path,
    name: path,
    appFile: "app.tsx",
    pageFile,
    layoutFile,
    loadModule: async (moduleId: string) => modules.get(moduleId),
    httpServer: server,
    cache: options.cache,
  };

  router.get(path, createPageRouteHandler(handlerOptions));

  if (options.withAction !== false) {
    router.post(path, createPageRouteHandler({ ...handlerOptions, mode: "action" }), {
      isPage: true,
    });
  }
}

/** devalue-decodes the `#__WARLOCK_DATA__` payload out of a rendered document. */
function documentPayload(html: string): Record<string, any> {
  const match = new RegExp(`<script id="${PAYLOAD_SCRIPT_ID}"[^>]*>(.*?)<\\/script>`).exec(html);

  if (match === null) throw new Error("payload script not found in rendered HTML");

  return parse(match[1]!) as Record<string, any>;
}

const signIn = v.object({
  email: v.string().email().required(),
  password: v.string().required(),
});

describe("page actions (real Fastify, real pipeline)", () => {
  const server = Fastify();

  beforeAll(async () => {
    const store = new AsyncLocalStorage<PipelineStore>();

    connectPageContext({
      buildStore: (payload) => payload as never,
      getStore: () => store.getStore(),
      run: (value, callback) => store.run(value, callback),
    });
    await registerHttpPlugins(server);

    // 3. a page without an action gets no POST at all.
    mountPage(server, "/__action-none", pageModule(), { withAction: false });

    // 4. no-JS redirect, with a cookie set in the action.
    mountPage(
      server,
      "/__action-redirect",
      pageModule({
        action: ({ response }: ActionContext) => {
          response.cookie("flash", "1");

          return response.redirect("/thanks");
        },
      }),
    );

    // 5, 6, 7, 8. validation, success and failure on one page.
    mountPage(
      server,
      "/__action-form",
      pageModule({
        config: { action: { validation: signIn } },
        action: ({ request }: ActionContext) => {
          actionCalls++;

          return { saved: true, email: request.validated().email };
        },
      }),
    );

    // 7. NDJSON settles a deferred key after the action.
    mountPage(
      server,
      "/__action-defer",
      pageModule({
        loader: () => {
          loaderCalls++;

          return defer({ slow: Promise.resolve("settled"), fast: 1 });
        },
        action: () => ({ ok: true }),
      }),
    );

    // 9, 10. a failure helper, and named actions.
    mountPage(
      server,
      "/__action-named",
      pageModule({
        actions: {
          remove: ({ request }: ActionContext) => {
            actionCalls++;

            return { validated: request.validated() };
          },
          reject: ({ response }: ActionContext) =>
            response.conflict({ message: "Already taken", errors: { name: "Taken" } }),
        },
        config: {
          actions: {
            remove: { validation: v.object({ id: v.string().required() }) },
          },
        },
      }),
    );

    // 11. a guarded layout short-circuits before the action.
    mountPage(
      server,
      "/__action-guarded",
      pageModule({
        action: () => {
          actionCalls++;

          return { ok: true };
        },
      }),
      {
        layout: {
          config: {
            middleware: [({ response }: ActionContext) => response.forbidden({ error: "no" })],
          },
        },
      },
    );

    // 13. a page that opted in to public caching never lets an action be cached.
    mountPage(
      server,
      "/__action-cached",
      pageModule({ action: () => ({ ok: true }) }),
      { cache: { public: true, maxAge: 120, serverCache: true } },
    );
    mountPage(server, "/__action-public", pageModule({ action: () => ({ ok: true }) }), {
      cache: { public: true, maxAge: 120 },
    });

    // session: the action and its middleware read `ctx.session` like loaders do.
    mountPage(
      server,
      "/__action-session",
      pageModule({
        config: {
          action: {
            middleware: [
              ({ session }: { session?: { user: { id: number } | null } }) => {
                sessionSeenByMiddleware = session?.user?.id;
              },
            ],
          },
        },
        action: (context: { session?: { user: { id: number } | null } }) => ({
          userId: context.session?.user?.id ?? null,
        }),
      }),
    );

    // 13. a public serverCache page: an action POST leaves its GET cache alone.
    mountPage(server, "/__action-servercache", pageModule({ action: () => ({ ok: true }) }), {
      cache: { public: true, maxAge: 120, serverCache: true },
    });

    // 14. multipart upload: the file reaches request.file, Seal rejects a wrong type.
    mountPage(
      server,
      "/__action-upload",
      pageModule({
        config: { action: { validation: v.object({ avatar: v.file().image().required() }) } },
        action: ({ request }: { request: any }) => ({
          filename: request.file("avatar")?.name ?? null,
        }),
      }),
    );

    router.scan(server);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    loaderCalls = 0;
    actionCalls = 0;
    sessionSeenByMiddleware = undefined;
    fakeCacheStore.clear();
    resetPageCacheDriverStateForTests();
  });

  it("answers 404 to a POST on a page that declares no action", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/__action-none",
      headers: FORM_HEADERS,
      payload: "a=1",
    });

    expect(response.statusCode).toBe(404);
  });

  it("fails the boot when an app router.post claims the path of a page action", async () => {
    mountPage(Fastify(), "/__action-clash", pageModule({ action: () => ({ ok: true }) }));
    router.post("/__action-clash", async () => ({ app: true }));

    const clashing = Fastify();

    await registerHttpPlugins(clashing);
    await expect(
      (async () => {
        router.scan(clashing);
        await clashing.ready();
      })(),
    ).rejects.toThrow(/already declared|duplicate/i);
  });

  it("answers a no-JS redirect with 303 and keeps the cookie the action set", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/__action-redirect",
      headers: FORM_HEADERS,
      payload: "email=a%40b.co",
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/thanks");
    expect(String(response.headers["set-cookie"])).toMatch(/flash=/);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("renders a 422 document with the field message and the echoed email, never the password", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/__action-form",
      headers: FORM_HEADERS,
      payload: "email=not-an-email&password=hunter2",
    });
    const { actionData } = documentPayload(response.body);

    expect(response.statusCode).toBe(422);
    expect(actionData.ok).toBe(false);
    expect(actionData.errors.email).toEqual(expect.any(String));
    expect(actionData.values).toEqual({ email: "not-an-email", password: undefined });
    expect(response.body).not.toContain("hunter2");
    expect(actionCalls).toBe(0);
    // the page still renders around the errors, so its loader ran
    expect(loaderCalls).toBe(1);
  });

  it("re-runs the loaders after a successful no-JS action and carries actionData", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/__action-form",
      headers: FORM_HEADERS,
      payload: "email=a%40b.co&password=x",
    });
    const payload = documentPayload(response.body);

    expect(response.statusCode).toBe(200);
    expect(loaderCalls).toBe(1);
    expect(payload.pageData).toEqual({ n: 1 });
    expect(payload.actionData.data).toEqual({ saved: true, email: "a@b.co" });
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("answers a data-request success with fresh pageData plus actionData", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/__action-form",
      headers: DATA_HEADERS,
      payload: "email=a%40b.co&password=x",
    });
    const payload = parse(response.body) as Record<string, any>;

    expect(response.statusCode).toBe(200);
    expect(payload.pageData).toEqual({ n: 1 });
    expect(payload.actionData.ok).toBe(true);
  });

  it("settles deferred keys on the NDJSON variant of an action success", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/__action-defer",
      headers: { ...DATA_HEADERS, accept: NDJSON_CONTENT_TYPE },
      payload: "a=1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("ndjson");
    expect(response.body).toContain("settled");
    expect(response.body).toContain("actionData");
  });

  it("answers a data-request failure with 422 and only { actionData }, without running loaders", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/__action-form",
      headers: DATA_HEADERS,
      payload: "email=nope&password=hunter2",
    });
    const body = parse(response.body) as Record<string, any>;

    expect(response.statusCode).toBe(422);
    expect(Object.keys(body)).toEqual(["actionData"]);
    expect(body.actionData.errors.email).toEqual(expect.any(String));
    expect(response.body).not.toContain("hunter2");
    expect(loaderCalls).toBe(0);
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("answers a data-request redirect with 204 and x-warlock-redirect, never a Location", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/__action-redirect",
      headers: DATA_HEADERS,
      payload: "a=1",
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["x-warlock-redirect"]).toBe("/thanks");
    expect(response.headers.location).toBeUndefined();
  });

  it("runs the named action, keeps _action out of validated(), and folds failure helpers", async () => {
    const removed = await server.inject({
      method: "POST",
      url: "/__action-named",
      headers: DATA_HEADERS,
      payload: "_action=remove&id=7",
    });
    const { actionData } = parse(removed.body) as Record<string, any>;

    expect(removed.statusCode).toBe(200);
    expect(actionData.action).toBe("remove");
    expect(actionData.data).toEqual({ validated: { id: "7" } });

    const rejected = await server.inject({
      method: "POST",
      url: "/__action-named",
      headers: DATA_HEADERS,
      payload: "_action=reject",
    });
    const failure = (parse(rejected.body) as Record<string, any>).actionData;

    expect(rejected.statusCode).toBe(409);
    expect(failure.errors).toEqual({ name: "Taken" });
    expect(failure.formErrors).toContain("Already taken");
  });

  it("answers an unknown _action with 404 for data and 400 for a document", async () => {
    const data = await server.inject({
      method: "POST",
      url: "/__action-named",
      headers: DATA_HEADERS,
      payload: "_action=nope",
    });
    const document = await server.inject({
      method: "POST",
      url: "/__action-named",
      headers: FORM_HEADERS,
      payload: "_action=nope",
    });

    expect(data.statusCode).toBe(404);
    expect(document.statusCode).toBe(400);
    expect(actionCalls).toBe(0);
  });

  it("never calls the action when a layout middleware short-circuits", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/__action-guarded",
      headers: FORM_HEADERS,
      payload: "a=1",
    });

    expect(response.statusCode).toBe(403);
    expect(actionCalls).toBe(0);
  });

  it("refuses a cookie-less POST with a foreign Origin, and admits a same-origin one", async () => {
    const foreign = await server.inject({
      method: "POST",
      url: "/__action-form",
      headers: { ...FORM_HEADERS, origin: "http://evil.example" },
      payload: "email=a%40b.co&password=x",
    });
    const missing = await server.inject({
      method: "POST",
      url: "/__action-form",
      headers: { "content-type": FORM_HEADERS["content-type"] },
      payload: "email=a%40b.co&password=x",
    });
    const same = await server.inject({
      method: "POST",
      url: "/__action-form",
      headers: FORM_HEADERS,
      payload: "email=a%40b.co&password=x",
    });

    expect(foreign.statusCode).toBe(403);
    expect(missing.statusCode).toBe(403);
    expect(same.statusCode).toBe(200);
    expect(actionCalls).toBe(1);
  });

  it("replies private, no-store on a page that opted in to caching, and stores nothing", async () => {
    const serverCached = await server.inject({
      method: "POST",
      url: "/__action-cached",
      headers: FORM_HEADERS,
      payload: "a=1",
    });
    const publicPost = await server.inject({
      method: "POST",
      url: "/__action-public",
      headers: FORM_HEADERS,
      payload: "a=1",
    });
    const publicGet = await server.inject({ method: "GET", url: "/__action-public" });

    expect(serverCached.statusCode).toBe(200);
    expect(serverCached.headers["cache-control"]).toBe("private, no-store");
    expect(serverCached.headers["x-warlock-cache"]).toBeUndefined();
    expect(publicPost.headers["cache-control"]).toBe("private, no-store");
    // the opt-in still governs the page's own GET
    expect(publicGet.headers["cache-control"]).toContain("public");
  });

  it("hands the resolved session to the action and its middleware, after stage 2.5", async () => {
    setConfig("web.session", {
      resolve: async () => ({ user: { id: 7 }, model: { id: 7 } }),
    } as never);

    try {
      const response = await server.inject({
        method: "POST",
        url: "/__action-session",
        headers: DATA_HEADERS,
        payload: "a=1",
      });
      const payload = parse(response.body) as Record<string, any>;

      expect(response.statusCode).toBe(200);
      expect(sessionSeenByMiddleware).toBe(7);
      expect(payload.actionData.data).toEqual({ userId: 7 });
    } finally {
      setConfig("web.session", undefined as never);
    }
  });

  it("leaves ctx.session absent on an action when web.session is not configured", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/__action-session",
      headers: DATA_HEADERS,
      payload: "a=1",
    });
    const payload = parse(response.body) as Record<string, any>;

    expect(sessionSeenByMiddleware).toBeUndefined();
    expect(payload.actionData.data).toEqual({ userId: null });
  });

  it("spec 13: an action POST on a public serverCache page neither stores nor evicts its GET", async () => {
    const first = await server.inject({ method: "GET", url: "/__action-servercache" });
    // the store is written after the reply leaves
    await vi.waitFor(() => expect(fakeCacheStore.size).toBeGreaterThan(0));
    const storedAfterGet = fakeCacheStore.size;
    const post = await server.inject({
      method: "POST",
      url: "/__action-servercache",
      headers: FORM_HEADERS,
      payload: "a=1",
    });
    const second = await server.inject({ method: "GET", url: "/__action-servercache" });

    expect(first.headers["x-warlock-cache"]).toBe("miss");
    expect(storedAfterGet).toBeGreaterThan(0);
    expect(post.headers["x-warlock-cache"]).toBeUndefined();
    expect(fakeCacheStore.size).toBe(storedAfterGet);
    expect(second.statusCode).toBe(200);
    expect(second.headers["x-warlock-cache"]).toBe("hit");
    expect(second.body).toBe(first.body);
  });

  it("spec 14: a multipart file reaches request.file, and a Seal file rule rejects the wrong type with 422", async () => {
    const good = multipartFile("avatar", "me.png", "image/png", "PNGDATA");
    const bad = multipartFile("avatar", "notes.txt", "text/plain", "hello");
    const accepted = await server.inject({
      method: "POST",
      url: "/__action-upload",
      headers: good.headers,
      payload: good.payload,
    });
    const rejected = await server.inject({
      method: "POST",
      url: "/__action-upload",
      headers: bad.headers,
      payload: bad.payload,
    });

    expect(accepted.statusCode).toBe(200);
    expect((parse(accepted.body) as Record<string, any>).actionData.data).toEqual({
      filename: "me.png",
    });
    expect(rejected.statusCode).toBe(422);
  });
});

