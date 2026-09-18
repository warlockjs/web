import { PassThrough } from "node:stream";
import type { PipeableStream } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeferSettlement } from "./defer-settlement";
import { wrapPipeableStreamForDeferredEmission } from "./defer-emission";

/** A fake React `PipeableStream` whose shell writes `shellHtml` then ends. */
function fakePipeableStream(shellHtml = "<html>shell</html>"): PipeableStream {
  return {
    pipe<Writable extends NodeJS.WritableStream>(destination: Writable): Writable {
      destination.write(shellHtml);
      destination.end();
      return destination;
    },
    abort: vi.fn(),
  } as unknown as PipeableStream;
}

/** A value devalue refuses to serialize — a function is one of the documented cases. */
const unserializableValue = { handler: () => undefined };

/**
 * A controllable fake React `PipeableStream`: writes the shell immediately
 * but does NOT end on its own — the caller decides when the shell "flushes"
 * (`endShell()`), and `abort()` mirrors React's real behaviour of ending the
 * underlying stream it was piping into.
 */
function controllablePipeableStream(shellHtml = "<html>shell</html>"): {
  stream: PipeableStream;
  abort: ReturnType<typeof vi.fn>;
  endShell: () => void;
} {
  let shellDestination: NodeJS.WritableStream | undefined;
  const abort = vi.fn(() => {
    shellDestination?.end();
  });

  return {
    stream: {
      pipe<Writable extends NodeJS.WritableStream>(destination: Writable): Writable {
        shellDestination = destination;
        destination.write(shellHtml);
        return destination;
      },
      abort,
    } as unknown as PipeableStream,
    abort,
    endShell: () => shellDestination?.end(),
  };
}

describe("wrapPipeableStreamForDeferredEmission()", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ends the destination even when a deferred value fails serialization", async () => {
    const wrapped = wrapPipeableStreamForDeferredEmission({
      pipeableStream: fakePipeableStream(),
      deferred: [
        {
          key: "reviews",
          settlement: Promise.resolve<DeferSettlement>({ ok: true, value: unserializableValue }),
        },
      ],
      nonce: undefined,
      allReady: Promise.resolve(),
      routeName: "dashboard",
    });

    const destination = new PassThrough();
    const ended = new Promise<void>((resolve) => destination.once("finish", () => resolve()));

    wrapped.pipe(destination);

    await Promise.race([
      ended.then(() => "ended"),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 500)),
    ]).then((result) => {
      expect(result).toBe("ended");
    });
  });

  it("settles the failing key in-band as a rejected settlement instead of vanishing", async () => {
    const wrapped = wrapPipeableStreamForDeferredEmission({
      pipeableStream: fakePipeableStream(),
      deferred: [
        {
          key: "reviews",
          settlement: Promise.resolve<DeferSettlement>({ ok: true, value: unserializableValue }),
        },
      ],
      nonce: undefined,
      allReady: Promise.resolve(),
      routeName: "dashboard",
    });

    const destination = new PassThrough();
    const chunks: Buffer[] = [];
    destination.on("data", (chunk: Buffer) => chunks.push(chunk));
    const ended = new Promise<void>((resolve) => destination.once("finish", () => resolve()));

    wrapped.pipe(destination);
    await ended;

    const written = Buffer.concat(chunks).toString("utf8");
    expect(written).toContain("__WARLOCK_DEFER__");
    expect(written).toContain("reviews");
    // The failure must reach the client as a rejected settlement, never as a
    // second response attempt — so it must land in-band as `ok:false`.
    expect(written).toMatch(/\\"ok\\":false|"ok":false|ok.*false/);
  });

  it("reports the serialization failure to the unconditional stderr floor", async () => {
    const wrapped = wrapPipeableStreamForDeferredEmission({
      pipeableStream: fakePipeableStream(),
      deferred: [
        {
          key: "reviews",
          settlement: Promise.resolve<DeferSettlement>({ ok: true, value: unserializableValue }),
        },
      ],
      nonce: undefined,
      allReady: Promise.resolve(),
      routeName: "dashboard",
    });

    const destination = new PassThrough();
    const ended = new Promise<void>((resolve) => destination.once("finish", () => resolve()));

    wrapped.pipe(destination);
    await ended;

    expect(console.error).toHaveBeenCalled();
  });

  it("calls destination.end() exactly once on ordinary success", async () => {
    const wrapped = wrapPipeableStreamForDeferredEmission({
      pipeableStream: fakePipeableStream(),
      deferred: [
        { key: "reviews", settlement: Promise.resolve<DeferSettlement>({ ok: true, value: 1 }) },
      ],
      nonce: undefined,
      allReady: Promise.resolve(),
      routeName: "dashboard",
    });

    const destination = new PassThrough();
    let endCalls = 0;
    const realEnd = destination.end.bind(destination);
    destination.end = ((...args: unknown[]) => {
      endCalls += 1;
      return (realEnd as (...args: unknown[]) => PassThrough)(...args);
    }) as typeof destination.end;

    const ended = new Promise<void>((resolve) => destination.once("finish", () => resolve()));
    wrapped.pipe(destination);
    await ended;

    expect(endCalls).toBe(1);
  });

  describe("client disconnect mid-stream", () => {
    it("aborts the React stream once, never writes the pending deferred chunk, and ends the destination once", async () => {
      const controller = new AbortController();
      const { stream, abort, endShell } = controllablePipeableStream();

      let releaseValue!: (value: DeferSettlement) => void;
      const settlement = new Promise<DeferSettlement>((resolve) => {
        releaseValue = resolve;
      });

      const wrapped = wrapPipeableStreamForDeferredEmission({
        pipeableStream: stream,
        deferred: [{ key: "reviews", settlement }],
        nonce: undefined,
        allReady: new Promise(() => undefined), // never resolves on its own — abort must end regardless
        routeName: "dashboard",
        signal: controller.signal,
      });

      const destination = new PassThrough();
      const chunks: Buffer[] = [];
      destination.on("data", (chunk: Buffer) => chunks.push(chunk));
      let endCalls = 0;
      const realEnd = destination.end.bind(destination);
      destination.end = ((...args: unknown[]) => {
        endCalls += 1;
        return (realEnd as (...args: unknown[]) => PassThrough)(...args);
      }) as typeof destination.end;
      const ended = new Promise<void>((resolve) => destination.once("finish", () => resolve()));

      wrapped.pipe(destination);
      endShell(); // the shell has flushed — mirrors a real request reaching that point

      // Disconnect BEFORE the pending deferred value ever settles.
      controller.abort();
      await ended;

      // The loader's own promise settles only after the disconnect — its
      // value must never reach the wire.
      releaseValue({ ok: true, value: 1 });
      await new Promise((resolve) => setImmediate(resolve));

      expect(abort).toHaveBeenCalledTimes(1);
      expect(endCalls).toBe(1);
      const written = Buffer.concat(chunks).toString("utf8");
      expect(written).not.toContain("reviews");
    });

    it("still streams normally when the client never disconnects (control)", async () => {
      const controller = new AbortController();
      const wrapped = wrapPipeableStreamForDeferredEmission({
        pipeableStream: fakePipeableStream(),
        deferred: [
          { key: "reviews", settlement: Promise.resolve<DeferSettlement>({ ok: true, value: 1 }) },
        ],
        nonce: undefined,
        allReady: Promise.resolve(),
        routeName: "dashboard",
        signal: controller.signal,
      });

      const destination = new PassThrough();
      const chunks: Buffer[] = [];
      destination.on("data", (chunk: Buffer) => chunks.push(chunk));
      const ended = new Promise<void>((resolve) => destination.once("finish", () => resolve()));

      wrapped.pipe(destination);
      await ended;

      const written = Buffer.concat(chunks).toString("utf8");
      expect(written).toContain("__WARLOCK_DEFER__");
      expect(written).toContain("reviews");
    });
  });

  describe("destination stream errors mid-stream", () => {
    it("ends the destination exactly once, reports the failure, and never writes the pending deferred chunk", async () => {
      const { stream, endShell } = controllablePipeableStream();

      let releaseValue!: (value: DeferSettlement) => void;
      const settlement = new Promise<DeferSettlement>((resolve) => {
        releaseValue = resolve;
      });

      const wrapped = wrapPipeableStreamForDeferredEmission({
        pipeableStream: stream,
        deferred: [{ key: "reviews", settlement }],
        nonce: undefined,
        allReady: new Promise(() => undefined), // never resolves on its own
        routeName: "dashboard",
      });

      const destination = new PassThrough();
      const chunks: Buffer[] = [];
      destination.on("data", (chunk: Buffer) => chunks.push(chunk));
      let endCalls = 0;
      const realEnd = destination.end.bind(destination);
      destination.end = ((...args: unknown[]) => {
        endCalls += 1;
        return (realEnd as (...args: unknown[]) => PassThrough)(...args);
      }) as typeof destination.end;
      const closed = new Promise<void>((resolve) => destination.once("close", () => resolve()));

      wrapped.pipe(destination);
      endShell(); // the shell has flushed — reaches the deferred-write phase

      // A real socket/writer failure mid-stream: destroy(error) is how Node
      // itself reports this (not a bare `emit`), and marks the stream
      // unwritable the same way a dropped connection would.
      destination.destroy(new Error("socket hang up"));
      await closed;

      // The loader's own promise settles only AFTER the destination errored —
      // its value must never reach the wire.
      releaseValue({ ok: true, value: 1 });
      await new Promise((resolve) => setImmediate(resolve));

      expect(endCalls).toBe(1);
      expect(console.error).toHaveBeenCalled();
      const written = Buffer.concat(chunks).toString("utf8");
      expect(written).not.toContain("reviews");
    });
  });
});
