/**
 * STREAMING DEFER — Stage 2 server slice gate (design record
 * `releases/v5.12-streaming-design.md`, "Stage 2 implementation contract").
 *
 * Real core `Request`/`Response` throughout, same construction as
 * `streamed-document.parity.spec.ts` in this directory — a hand mock of
 * `response.streamReact` would prove nothing about the real wire seam this
 * file exists to gate.
 */
import { createElement } from "react";
import { parse } from "devalue";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Response, setConfig } from "@warlock.js/core";
import { createCoreHttp, requestContext } from "../../src/server/__fixtures__/core-http";
import * as App from "./fixtures/root";
import * as layout from "./fixtures/layout";
import { defer } from "../../src/loaders/defer";
import { DeferredInNonPageLoaderError, NestedDeferredValueError } from "../../src/loaders/defer";
import {
  connectPageContext,
  renderPageRequest,
  type PageContextRunner,
  type PageRouteEntry,
  type PageTripleModule,
} from "../../src/server/index";
import { connectSharedStore, type SharedStoreResolver } from "../../src/shared";

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

afterEach(() => {
  setConfig("web", {});
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Flush every pending microtask AND macrotask. */
async function flushAsyncWork(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function deferredKeyChunks(wireHtml: string): { key: string; index: number }[] {
  const matches = [...wireHtml.matchAll(/__WARLOCK_DEFER__\((".*?")/g)];
  return matches.map((match) => ({ key: JSON.parse(match[1]!), index: match.index! }));
}

/**
 * Decodes one `__WARLOCK_DEFER__(key, "<devalue text>")` chunk's settlement
 * back to the real value it carries — the chunk's second argument is a JSON
 * string literal wrapping devalue's own serialized text (`defer-emission.ts`'s
 * `deferCallScript`), so this undoes both layers: `JSON.parse` for the string
 * literal, then devalue's `parse` for what it actually encodes.
 */
function decodedDeferSettlement(wireHtml: string, key: string): unknown {
  const match = new RegExp(`__WARLOCK_DEFER__\\(${JSON.stringify(key)}, (".*?")\\)`).exec(wireHtml);

  if (match === null) throw new Error(`no __WARLOCK_DEFER__ chunk found for key "${key}"`);

  return parse(JSON.parse(match[1]!));
}

describe("streamed defer() — a resolved deferred value", () => {
  it(
    "streams the shell first, then the chunk script carrying the request's nonce, then ends",
    async () => {
      let releaseReviews!: (value: unknown) => void;
      const reviews = new Promise((resolve) => {
        releaseReviews = resolve;
      });

      const page = {
        loader: async () => defer({ greeting: "Hello streaming", reviews }),
        default: ({ data }: { data: { greeting: string } }) =>
          createElement("main", null, createElement("h1", null, data.greeting)),
      };

      const entry: PageRouteEntry = {
        path: "/dashboard",
        name: "dashboard",
        triple: {
          app: App as unknown as PageTripleModule,
          layout: layout as unknown as PageTripleModule,
          page: page as unknown as PageTripleModule,
        },
      };

      const http = createCoreHttp({ url: "/dashboard" });
      const chunks: Buffer[] = [];
      http.reply.raw.on("data", (chunk: Buffer) => chunks.push(chunk));

      const rendered = await renderPageRequest("/dashboard", {
        routes: [entry],
        createHttp: () => ({ request: http.request, response: http.response }),
      });

      if (rendered instanceof Response) throw new Error("unexpected terminal Response");
      expect(rendered.pipeableStream).toBeDefined();

      http.response.setContentType("text/html");
      http.response.setStatusCode(rendered.status);

      const streamed = http.response.streamReact(rendered.pipeableStream!);

      // Give the shell every chance to flush before the deferred value settles.
      await flushAsyncWork();
      expect(http.reply.raw.writableEnded).toBe(false);

      releaseReviews([{ id: 1, rating: 5 }]);
      await streamed;

      const wireHtml = Buffer.concat(chunks).toString("utf8");
      const shellIndex = wireHtml.indexOf("Hello streaming");
      const chunkMatches = deferredKeyChunks(wireHtml);

      expect(shellIndex).toBeGreaterThanOrEqual(0);
      expect(chunkMatches).toHaveLength(1);
      expect(chunkMatches[0]!.key).toBe("reviews");
      expect(chunkMatches[0]!.index).toBeGreaterThan(shellIndex);
      expect(wireHtml).toContain(`nonce="${http.request.nonce}"`);
      expect(decodedDeferSettlement(wireHtml, "reviews")).toEqual({
        ok: true,
        value: [{ id: 1, rating: 5 }],
      });
      expect(http.reply.raw.writableEnded).toBe(true);
    },
    20_000,
  );

  it(
    "ends the response only after the last deferred key has settled",
    async () => {
      let releaseSlow!: () => void;
      const slow = new Promise<unknown>((resolve) => {
        releaseSlow = () => resolve({ ok: "finally" });
      });

      const page = {
        loader: async () => defer({ greeting: "waiting", slow }),
        default: ({ data }: { data: { greeting: string } }) =>
          createElement("main", null, data.greeting),
      };

      const entry: PageRouteEntry = {
        path: "/slow",
        name: "slow",
        triple: {
          app: App as unknown as PageTripleModule,
          layout: {} as PageTripleModule,
          page: page as unknown as PageTripleModule,
        },
      };

      const http = createCoreHttp({ url: "/slow" });

      const rendered = await renderPageRequest("/slow", {
        routes: [entry],
        createHttp: () => ({ request: http.request, response: http.response }),
      });

      if (rendered instanceof Response) throw new Error("unexpected terminal Response");

      http.response.setContentType("text/html");
      http.response.setStatusCode(rendered.status);
      const streamed = http.response.streamReact(rendered.pipeableStream!);

      await flushAsyncWork();
      expect(http.reply.raw.writableEnded).toBe(false);

      releaseSlow();
      await streamed;

      expect(http.reply.raw.writableEnded).toBe(true);
    },
    20_000,
  );
});

describe("streamed defer() — a rejected deferred value", () => {
  it(
    "emits an ok:false chunk with no stack in production, and reports to the server error sink",
    async () => {
      vi.stubEnv("NODE_ENV", "production");
      const errorSink = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const failure = new Error("reviews service is down");
      const page = {
        loader: async () => defer({ greeting: "hi", reviews: Promise.reject(failure) }),
        default: ({ data }: { data: { greeting: string } }) =>
          createElement("main", null, data.greeting),
      };

      const entry: PageRouteEntry = {
        path: "/broken",
        name: "broken",
        triple: {
          app: App as unknown as PageTripleModule,
          layout: {} as PageTripleModule,
          page: page as unknown as PageTripleModule,
        },
      };

      const http = createCoreHttp({ url: "/broken" });
      const chunks: Buffer[] = [];
      http.reply.raw.on("data", (chunk: Buffer) => chunks.push(chunk));

      const rendered = await renderPageRequest("/broken", {
        routes: [entry],
        createHttp: () => ({ request: http.request, response: http.response }),
      });

      if (rendered instanceof Response) throw new Error("unexpected terminal Response");

      http.response.setContentType("text/html");
      http.response.setStatusCode(rendered.status);
      await http.response.streamReact(rendered.pipeableStream!);

      const wireHtml = Buffer.concat(chunks).toString("utf8");
      const settlement = decodedDeferSettlement(wireHtml, "reviews") as {
        ok: boolean;
        error: { name: string; message: string; stack?: string };
      };
      expect(settlement.ok).toBe(false);
      expect(settlement.error.name).toBe("Error");
      expect(settlement.error.message).toBe("reviews service is down");
      expect(settlement.error.stack).toBeUndefined();

      expect(errorSink).toHaveBeenCalledTimes(1);
      expect(errorSink.mock.calls[0]?.[0]).toContain('deferred value "reviews" rejected');
    },
    20_000,
  );
});

describe("streamed defer() — a deferred value that never settles", () => {
  it(
    "settles the chunk with DeferTimeoutError once web.streaming.deferTimeout elapses",
    async () => {
      setConfig("web", { streaming: { deferTimeout: 25 } });
      const errorSink = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const page = {
        loader: async () =>
          defer({ greeting: "hi", reviews: new Promise<never>(() => undefined) }),
        default: ({ data }: { data: { greeting: string } }) =>
          createElement("main", null, data.greeting),
      };

      const entry: PageRouteEntry = {
        path: "/stuck",
        name: "stuck",
        triple: {
          app: App as unknown as PageTripleModule,
          layout: {} as PageTripleModule,
          page: page as unknown as PageTripleModule,
        },
      };

      const http = createCoreHttp({ url: "/stuck" });
      const chunks: Buffer[] = [];
      http.reply.raw.on("data", (chunk: Buffer) => chunks.push(chunk));

      const rendered = await renderPageRequest("/stuck", {
        routes: [entry],
        createHttp: () => ({ request: http.request, response: http.response }),
      });

      if (rendered instanceof Response) throw new Error("unexpected terminal Response");

      http.response.setContentType("text/html");
      http.response.setStatusCode(rendered.status);
      await http.response.streamReact(rendered.pipeableStream!);

      const wireHtml = Buffer.concat(chunks).toString("utf8");
      const settlement = decodedDeferSettlement(wireHtml, "reviews") as {
        error: { name: string };
      };
      expect(settlement.error.name).toBe("DeferTimeoutError");
      expect(http.reply.raw.writableEnded).toBe(true);
      expect(errorSink).toHaveBeenCalled();
      expect(
        errorSink.mock.calls.some((call) => String(call[0]).includes('deferred value "reviews" timed out')),
      ).toBe(true);
    },
    20_000,
  );
});

describe("defer() misuse", () => {
  it("throws NestedDeferredValueError naming the path when a promise is nested under a resolved key", async () => {
    const page = {
      loader: async () => defer({ list: { items: Promise.resolve(1) } }),
      default: () => createElement("main", null, "never rendered"),
    };

    const entry: PageRouteEntry = {
      path: "/nested",
      name: "nested",
      triple: {
        app: App as unknown as PageTripleModule,
        layout: {} as PageTripleModule,
        page: page as unknown as PageTripleModule,
      },
    };

    const http = createCoreHttp({ url: "/nested" });

    await expect(
      renderPageRequest("/nested", {
        routes: [entry],
        createHttp: () => ({ request: http.request, response: http.response }),
      }),
    ).rejects.toThrow(NestedDeferredValueError);
  });

  it("throws DeferredInNonPageLoaderError when a LAYOUT loader returns defer()", async () => {
    const brokenLayout = {
      loader: async () => defer({ nav: Promise.resolve(["a"]) }),
      default: ({ children }: { children: unknown }) => children,
    };

    const page = {
      default: () => createElement("main", null, "page"),
    };

    const entry: PageRouteEntry = {
      path: "/layout-defer",
      name: "layout-defer",
      triple: {
        app: App as unknown as PageTripleModule,
        layout: brokenLayout as unknown as PageTripleModule,
        page: page as unknown as PageTripleModule,
      },
    };

    const http = createCoreHttp({ url: "/layout-defer" });

    await expect(
      renderPageRequest("/layout-defer", {
        routes: [entry],
        createHttp: () => ({ request: http.request, response: http.response }),
      }),
    ).rejects.toThrow(DeferredInNonPageLoaderError);
  });
});

describe("streamed defer() — chunk escaping", () => {
  it(
    "a deferred value containing </script> markup cannot break out of its own <script> chunk",
    async () => {
      const hostile = '</script><script>alert(1)</script>';

      const page = {
        loader: async () =>
          defer({ greeting: "hi", reviews: Promise.resolve({ comment: hostile }) }),
        default: ({ data }: { data: { greeting: string } }) =>
          createElement("main", null, data.greeting),
      };

      const entry: PageRouteEntry = {
        path: "/hostile",
        name: "hostile",
        triple: {
          app: App as unknown as PageTripleModule,
          layout: {} as PageTripleModule,
          page: page as unknown as PageTripleModule,
        },
      };

      const http = createCoreHttp({ url: "/hostile" });
      const chunks: Buffer[] = [];
      http.reply.raw.on("data", (chunk: Buffer) => chunks.push(chunk));

      const rendered = await renderPageRequest("/hostile", {
        routes: [entry],
        createHttp: () => ({ request: http.request, response: http.response }),
      });

      if (rendered instanceof Response) throw new Error("unexpected terminal Response");

      http.response.setContentType("text/html");
      http.response.setStatusCode(rendered.status);
      await http.response.streamReact(rendered.pipeableStream!);

      const wireHtml = Buffer.concat(chunks).toString("utf8");

      // The literal, un-escaped attack string must never appear on the wire.
      // Every `<` is escaped by devalue's own `stringify` (its `<`,
      // uppercase, doubled to `\\u003C` once `JSON.stringify` escapes that
      // literal backslash for the string-literal argument) and every
      // remaining `>` by `escapePayload` (`>`) — two escaping layers,
      // with different backslash counts, agreeing on the SAME invariant this
      // spec gates: no literal `<` or `>` survives into the chunk script, so
      // the hostile value can never break out of it.
      expect(wireHtml).not.toContain(hostile);
      expect(wireHtml).not.toContain("<script>alert(1)</script>");

      const chunkArgumentMatch = /__WARLOCK_DEFER__\("reviews", (".*?")\)/.exec(wireHtml);
      expect(chunkArgumentMatch, "expected a reviews chunk on the wire").not.toBeNull();
      const chunkArgument = chunkArgumentMatch![1]!;

      // No RAW `<` or `>` survives inside the chunk's own argument text —
      // only their escaped `<`/`<` / `>` forms do.
      expect(chunkArgument).not.toMatch(/[<>]/);

      // And decoding the chunk back proves the ESCAPING never corrupted the
      // actual value — the hostile string round-trips byte-for-byte.
      expect(decodedDeferSettlement(wireHtml, "reviews")).toEqual({
        ok: true,
        value: { comment: hostile },
      });
    },
    20_000,
  );
});
