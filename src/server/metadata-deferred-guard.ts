/**
 * A page's `metadata` may read only RESOLVED loader keys. `defer()`-ed keys
 * resolve after the shell has already flushed — `<head>` (and a client
 * navigation's rewritten head) is decided before any of them settle, so a
 * metadata function that reads one is not "a little early", it is reading
 * something that, by construction, this render can never produce.
 *
 * The guard is a `Proxy` over `bundle.pageData` that traps `get` for exactly
 * the deferred key names and throws {@link DeferredKeyInMetadataError} —
 * naming the key and the page — the instant `metadata()` reads one, in dev
 * AND in production, with no dev-only exception. Every OTHER key reads
 * straight through `Reflect.get`, so a page's ordinary, resolved data is
 * exactly as cheap to read as it always was, and a page that never called
 * `defer()` gets its original `data` object back untouched — no `Proxy`, no
 * wrapping cost, nothing to trap.
 */

/** Raised when `metadata()` reads a `defer()`-ed key — see the module doc above. */
export class DeferredKeyInMetadataError extends Error {
  public constructor(
    public readonly key: string,
    public readonly pagePath: string,
  ) {
    super(
      `Page "${pagePath}": metadata() read "${key}", a defer()-ed key. metadata() runs before ` +
        "the shell flushes, but a deferred value resolves only after it — read only resolved " +
        "loader keys in metadata(); read the deferred value from inside the page component's " +
        "own `use()` call instead.",
    );
    this.name = "DeferredKeyInMetadataError";
  }
}

/**
 * Wrap `data` so that reading any of `deferredKeys` throws
 * {@link DeferredKeyInMetadataError} instead of handing `metadata()` a
 * pending (or, on the client-navigation data path, still-unresolved) promise.
 *
 * Returns `data` UNCHANGED — no `Proxy` at all — whenever there is nothing to
 * guard: no deferred keys, or a `data` that is not an object a `Proxy` can
 * wrap (e.g. `undefined` on the framework's own error metadata path, which
 * never reaches this function's caller anyway, but stays safe regardless).
 */
export function guardMetadataAgainstDeferredKeys(
  data: unknown,
  deferredKeys: readonly string[] | undefined,
  pagePath: string,
): unknown {
  if (!deferredKeys || deferredKeys.length === 0) return data;
  if (data === null || typeof data !== "object") return data;

  const deferred = new Set(deferredKeys);

  return new Proxy(data as Record<PropertyKey, unknown>, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && deferred.has(prop)) {
        throw new DeferredKeyInMetadataError(prop, pagePath);
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}
