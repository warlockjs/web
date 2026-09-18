/**
 * The page cache's per-entry byte ceiling — `pageCache.maxEntryBytes`
 * (default 1 MiB). Exists because a page-cache MISS used to buffer the
 * entire rendered document purely to hand it to `setPageCacheEntry`
 * (`page-cache-store.ts`), with no limit: a large document was fully
 * buffered AND cached, unbounded.
 *
 * `tapPipeableStreamForPageCacheLimit` decouples "what the visitor receives"
 * from "what gets handed to the store": the visitor's copy is always sent in
 * full (never truncated, never delayed by this ceiling) via the returned
 * `pipeable`, while a second, capped copy is accumulated only for the store.
 * The moment that second copy crosses the ceiling it is dropped and never
 * grown again — the live side is untouched.
 */
import { PassThrough, Writable } from "node:stream";
import { config } from "@warlock.js/core";

/** Default ceiling for one stored page-cache entry — 1 MiB. */
export const DEFAULT_PAGE_CACHE_MAX_ENTRY_BYTES = 1_048_576;

/**
 * Raised at config-read time when `pageCache.maxEntryBytes` is anything
 * other than a positive finite integer — named explicitly, per this
 * package's `[warlock:web]` convention, so a misconfigured app fails loudly
 * at boot/request time instead of silently caching (or silently refusing to
 * cache) every page.
 */
export class InvalidPageCacheMaxEntryBytesError extends Error {
  public constructor(value: unknown) {
    super(
      `"pageCache.maxEntryBytes" must be a positive finite integer (bytes), received ` +
        `${JSON.stringify(value)}.`,
    );
    this.name = "InvalidPageCacheMaxEntryBytesError";
  }
}

/**
 * Reads and validates `pageCache.maxEntryBytes`. Read fresh on every call,
 * deliberately not memoized — the same convention `auth-cookie-name.ts`'s
 * `resolveAuthCookieName` uses, so a hot-reloadable dev config and per-test
 * `setConfig` calls both take effect immediately.
 */
export function resolvePageCacheMaxEntryBytes(): number {
  const value = config.key("pageCache.maxEntryBytes", DEFAULT_PAGE_CACHE_MAX_ENTRY_BYTES);

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new InvalidPageCacheMaxEntryBytesError(value);
  }

  return value;
}

/**
 * The one structured observation this ceiling ever emits. There is no
 * existing skip-reason/telemetry channel in this package to plug into —
 * `page-cache-eligibility.ts`'s `isStoreEligible` fails closed silently, and
 * `dispatchPhase`/`buildTracingContext` (`create-page-route-handler.ts`) are
 * a perf-tracing channel keyed on duration, not a fit for a structured skip
 * reason — so this reuses `console.warn`, the same `[warlock:web]`-prefixed
 * convention `report-server-error.ts` established for this package's
 * unconditional stderr floor.
 */
export function reportPageCacheEntryTooLarge(bytes: number, limit: number): void {
  console.warn("[warlock:web] page-cache entry not stored:", {
    reason: "entry_too_large",
    bytes,
    limit,
  });
}

/** The part of React's `PipeableStream` this module needs. */
export type CappablePipeableStream = {
  pipe<Destination extends NodeJS.WritableStream>(destination: Destination): Destination;
  abort(reason?: unknown): void;
};

export type PageCacheEntryLimitResult =
  { tooLarge: false; body: string } | { tooLarge: true; bytes: number };

/**
 * Wraps a React pipeable stream so the live response can be sent from the
 * returned `pipeable` exactly as if it were the original stream, while a
 * SEPARATE, capped copy of the same bytes is accumulated for the page cache
 * entry. See the file header for why the two copies are kept apart.
 */
export function tapPipeableStreamForPageCacheLimit(
  stream: CappablePipeableStream,
  maxEntryBytes: number,
): { pipeable: CappablePipeableStream; result: Promise<PageCacheEntryLimitResult> } {
  const liveSide = new PassThrough();

  let bytes = 0;
  let overCap = false;
  let chunks: Buffer[] = [];

  const result = new Promise<PageCacheEntryLimitResult>((resolve, reject) => {
    const tap = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        bytes += buffer.length;

        if (!overCap) {
          if (bytes > maxEntryBytes) {
            // Crossed the ceiling: stop accumulating for the store — drop
            // what was collected so far and never push another chunk onto
            // it. The live side below is entirely unaffected.
            overCap = true;
            chunks = [];
          } else {
            chunks.push(buffer);
          }
        }

        liveSide.write(buffer, callback);
      },
      final(callback) {
        liveSide.end();
        callback();
      },
    });

    tap.on("finish", () => {
      resolve(
        overCap
          ? { tooLarge: true, bytes }
          : { tooLarge: false, body: Buffer.concat(chunks).toString("utf8") },
      );
    });
    tap.on("error", reject);

    stream.pipe(tap);
  });

  return {
    pipeable: {
      pipe: (destination) => liveSide.pipe(destination),
      // Forwarded so a client disconnect (`stream-react-response.ts`'s
      // `onDisconnect`) still reaches the real React render through this
      // wrapper, exactly as it would with the original stream.
      abort: (reason) => stream.abort(reason),
    },
    result,
  };
}
