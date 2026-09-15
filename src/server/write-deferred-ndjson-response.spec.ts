import { describe, expect, it } from "vitest";
import { createCoreHttp } from "../../__tests__/server/fixtures/core-http";
import type { PageDataBundle } from "./execute-page-request";
import { NDJSON_CONTENT_TYPE, writeDeferredNdjsonResponse } from "./write-deferred-ndjson-response";

/** Wait for every pending microtask/macrotask so the raw stream has flushed. */
async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function bundleWith(overrides: Partial<PageDataBundle>): PageDataBundle {
  return {
    route: { name: "dashboard", path: "/dashboard", params: {}, query: {} },
    appData: {},
    layoutData: {},
    pageData: { greeting: "hi" },
    shared: {} as never,
    ...overrides,
  };
}

describe("writeDeferredNdjsonResponse()", () => {
  it("writes line 1 as the full payload (deferred included, deferred keys omitted from pageData), then settles each key on its own line, then ends", async () => {
    let releaseA!: (value: unknown) => void;
    let releaseB!: (value: unknown) => void;
    const a = new Promise((resolve) => {
      releaseA = resolve;
    });
    const b = new Promise((resolve) => {
      releaseB = resolve;
    });

    const bundle = bundleWith({
      pageData: { greeting: "hi", a, b },
      deferredKeys: ["a", "b"],
      deferredSettlements: {
        a: a.then((value) => ({ ok: true, value }) as const),
        b: b.then((value) => ({ ok: true, value }) as const),
      },
    });

    const http = createCoreHttp({ url: "/dashboard" });
    const chunks: Buffer[] = [];
    http.reply.raw.on("data", (chunk: Buffer) => chunks.push(chunk));

    const writing = writeDeferredNdjsonResponse(http.response, bundle, "en", 200);

    await flush();
    // Neither deferred key has settled yet — only line 1 is on the wire.
    let lines = Buffer.concat(chunks).toString("utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const line1 = JSON.parse(lines[0]!);
    expect(line1.deferred).toEqual(["a", "b"]);
    expect(line1.pageData).toEqual({ greeting: "hi" }); // deferred keys omitted

    // "B" settles first — SETTLEMENT order, not declaration order.
    releaseB(2);
    await flush();
    releaseA(1);
    await flush();
    await writing;

    lines = Buffer.concat(chunks).toString("utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1]!)).toEqual({ defer: "b", settlement: { ok: true, value: 2 } });
    expect(JSON.parse(lines[2]!)).toEqual({ defer: "a", settlement: { ok: true, value: 1 } });

    expect(http.reply.appliedHeaders["content-type"]).toBe(NDJSON_CONTENT_TYPE);
    expect(http.reply.raw.writableEnded).toBe(true);
  });

  it("writes an error settlement line for a rejected deferred key", async () => {
    const bundle = bundleWith({
      pageData: { greeting: "hi", reviews: Promise.resolve(undefined) },
      deferredKeys: ["reviews"],
      deferredSettlements: {
        reviews: Promise.resolve({
          ok: false,
          error: { name: "Error", message: "boom" },
        } as const),
      },
    });

    const http = createCoreHttp({ url: "/dashboard" });
    const chunks: Buffer[] = [];
    http.reply.raw.on("data", (chunk: Buffer) => chunks.push(chunk));

    await writeDeferredNdjsonResponse(http.response, bundle, "en", 200);

    const lines = Buffer.concat(chunks).toString("utf8").trim().split("\n");
    expect(JSON.parse(lines[1]!)).toEqual({
      defer: "reviews",
      settlement: { ok: false, error: { name: "Error", message: "boom" } },
    });
  });
});
