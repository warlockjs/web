/**
 * Unit-level coverage for `page-cache-entry-limit.ts` in isolation — no
 * Fastify, no router, no `@warlock.js/cache`. `page-server-cache.spec.ts`
 * proves the ceiling end to end through a real MISS/HIT cycle; this file
 * proves the two primitives it is built from: `resolvePageCacheMaxEntryBytes`
 * refuses a bad config value by name, and `tapPipeableStreamForPageCacheLimit`
 * keeps the live copy whole while capping only the store-bound copy.
 */
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { setConfig } from "@warlock.js/core";
import {
  DEFAULT_PAGE_CACHE_MAX_ENTRY_BYTES,
  InvalidPageCacheMaxEntryBytesError,
  resolvePageCacheMaxEntryBytes,
  tapPipeableStreamForPageCacheLimit,
  type CappablePipeableStream,
} from "./page-cache-entry-limit";

afterEach(() => {
  setConfig("pageCache.maxEntryBytes", undefined as never);
});

/** A stream that hands `chunks` to `pipe`'s destination synchronously. */
function fakePipeableStream(chunks: string[]): CappablePipeableStream & { aborted: unknown[] } {
  const aborted: unknown[] = [];

  return {
    aborted,
    pipe<Destination extends NodeJS.WritableStream>(destination: Destination): Destination {
      for (const chunk of chunks) destination.write(chunk);
      destination.end();
      return destination;
    },
    abort(reason?: unknown) {
      aborted.push(reason);
    },
  };
}

async function drain(pipeable: CappablePipeableStream): Promise<string> {
  const sink = new PassThrough();
  const received: Buffer[] = [];
  sink.on("data", (chunk: Buffer) => received.push(chunk));

  await new Promise<void>((resolve, reject) => {
    sink.on("finish", resolve);
    sink.on("error", reject);
    pipeable.pipe(sink);
  });

  return Buffer.concat(received).toString("utf8");
}

describe("resolvePageCacheMaxEntryBytes", () => {
  it("defaults to 1 MiB when unconfigured", () => {
    expect(resolvePageCacheMaxEntryBytes()).toBe(DEFAULT_PAGE_CACHE_MAX_ENTRY_BYTES);
    expect(DEFAULT_PAGE_CACHE_MAX_ENTRY_BYTES).toBe(1_048_576);
  });

  it("honours a valid configured value", () => {
    setConfig("pageCache.maxEntryBytes", 2048);

    expect(resolvePageCacheMaxEntryBytes()).toBe(2048);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["non-integer", 1.5],
    ["a string", "1mb"],
  ])("refuses %s at config read, naming the key", (_label, invalid) => {
    setConfig("pageCache.maxEntryBytes", invalid as never);

    let thrown: unknown;
    try {
      resolvePageCacheMaxEntryBytes();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InvalidPageCacheMaxEntryBytesError);
    expect((thrown as Error).message).toContain("pageCache.maxEntryBytes");
  });
});

describe("tapPipeableStreamForPageCacheLimit", () => {
  it("sends the live side in full even when the capped copy is dropped", async () => {
    const chunks = ["a".repeat(10), "b".repeat(10), "c".repeat(10)];
    const source = fakePipeableStream(chunks);
    const { pipeable, result } = tapPipeableStreamForPageCacheLimit(source, 15);

    const [live, capped] = await Promise.all([drain(pipeable), result]);

    expect(live).toBe(chunks.join(""));
    expect(capped).toEqual({ tooLarge: true, bytes: 30 });
  });

  it("returns the accumulated body for a document under the ceiling", async () => {
    const chunks = ["hello ", "world"];
    const source = fakePipeableStream(chunks);
    const { pipeable, result } = tapPipeableStreamForPageCacheLimit(source, 1024);

    const [live, capped] = await Promise.all([drain(pipeable), result]);

    expect(live).toBe("hello world");
    expect(capped).toEqual({ tooLarge: false, body: "hello world" });
  });

  it("reports the exact byte count the ceiling was crossed at, not the ceiling itself", async () => {
    const source = fakePipeableStream(["x".repeat(100)]);
    const { pipeable, result } = tapPipeableStreamForPageCacheLimit(source, 40);

    await drain(pipeable);

    expect(await result).toEqual({ tooLarge: true, bytes: 100 });
  });

  it("forwards abort() to the original stream, not the tap", () => {
    const source = fakePipeableStream(["irrelevant"]);
    const { pipeable } = tapPipeableStreamForPageCacheLimit(source, 1024);

    pipeable.abort("client disconnected");

    expect(source.aborted).toEqual(["client disconnected"]);
  });
});
