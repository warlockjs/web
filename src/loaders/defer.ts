/**
 * The `defer()` marker a PAGE loader returns to stream some of its data
 * after the shell instead of blocking the first byte on it.
 *
 * Server-safe by construction: this file imports nothing from React, nothing
 * from `react-dom/server`, and nothing that ships client bundle weight — a
 * page loader runs on the server only, and `isDeferred`/`DEFERRED_BRAND` are
 * read again on the client registry (a separate module `@warlock.js/web`
 * owns) purely as a marker check, never as a runtime dependency.
 */

/**
 * The brand every `defer()` result carries. `Symbol.for` (a REGISTRY symbol,
 * not a module-local `Symbol()`) on purpose: the server bundle and the
 * client bundle are two separate module graphs, and the server's
 * `isDeferred()` must recognize a value created by whichever copy of this
 * module produced it — `Symbol.for("warlock.defer")` guarantees both graphs
 * read the exact same symbol from the process-wide registry rather than two
 * unequal symbols that merely print the same description.
 */
export const DEFERRED_BRAND: unique symbol = Symbol.for("warlock.defer");

/** The branded object `defer()` returns — see the module doc above. */
export type DeferredResult<TData extends Record<string, unknown>> = {
  readonly [DEFERRED_BRAND]: true;
  readonly data: TData;
};

/**
 * Mark a page loader's return value as PARTIALLY streamed: any top-level key
 * of `data` that is a promise streams to the browser after the shell instead
 * of blocking it (Stage 2 D1-D3). A loader that returns a plain object,
 * unchanged, keeps today's fully-buffered contract.
 *
 * ```ts
 * export const loader = (async ({ request }) =>
 *   defer({ product: await getProduct(id), reviews: getReviews(id) })
 * ) satisfies PageLoader;
 * // page: const reviews = use(data.reviews) inside <Suspense fallback={...}>
 * ```
 */
export function defer<TData extends Record<string, unknown>>(
  data: TData,
): DeferredResult<TData> {
  return { [DEFERRED_BRAND]: true, data };
}

/** Narrow an arbitrary loader return value to a `defer()` result. */
export function isDeferred(value: unknown): value is DeferredResult<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[DEFERRED_BRAND] === true
  );
}

/**
 * Raised when a LAYOUT or APP loader returns `defer()`. Streaming is page-
 * loader-only in v1 (design doc, "Out of scope for 5.12") — an app/layout
 * loader's data is needed to compose every page under it, including pages
 * that never render a `<Suspense>` boundary, so deferring it would either
 * block on it anyway (pointless) or leave the document composing around a
 * promise nothing ever unwraps.
 */
export class DeferredInNonPageLoaderError extends Error {
  public constructor(level: "app" | "layout") {
    super(
      `defer() was returned by the ${level} loader, but streaming is supported only in PAGE ` +
        "loaders. Move the deferred value into " +
        "the page's own loader, or resolve it before returning it from the " +
        `${level} loader.`,
    );
    this.name = "DeferredInNonPageLoaderError";
  }
}

/**
 * Raised when a value NESTED under a top-level key is itself a promise —
 * `defer({ list: { items: fetchItems() } })`. Only TOP-LEVEL keys of `data`
 * may be deferred (contract rule 2); a nested promise has no key of its own
 * to list in the wire payload's `deferred` array and no way for the client
 * registry to address it, so it is refused rather than silently ignored
 * (silently ignoring it would ship an unresolved `Promise` object into
 * `pageData`, which neither JSON.stringify nor a component expects).
 */
export class NestedDeferredValueError extends Error {
  public constructor(path: string) {
    super(
      `defer(): the value at "${path}" is a Promise nested inside a top-level key. Only ` +
        'TOP-LEVEL keys of defer()\'s argument may be promises — move "' +
        path +
        '" to its own top-level key.',
    );
    this.name = "NestedDeferredValueError";
  }
}

/** Structural thenable check — a real `Promise`, or anything promise-like. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/**
 * Walk a RESOLVED top-level value looking for a promise nested underneath
 * it, throwing {@link NestedDeferredValueError} the moment one is found.
 * Only plain objects and arrays are walked — a class instance (a Date, a
 * Model, anything with a custom prototype) is treated as an opaque leaf, the
 * same way `JSON.stringify` would rather not guess how to serialize it.
 */
function assertNoNestedDeferred(value: unknown, path: string): void {
  if (isThenable(value)) throw new NestedDeferredValueError(path);

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoNestedDeferred(item, `${path}[${index}]`));
    return;
  }

  if (value !== null && typeof value === "object" && value.constructor === Object) {
    for (const [key, nested] of Object.entries(value)) {
      assertNoNestedDeferred(nested, `${path}.${key}`);
    }
  }
}

/** `splitDeferredPageData`'s result — see that function. */
export type SplitDeferredPageData = {
  /**
   * The SAME shape a page loader has always returned: every key present,
   * resolved values as-is, and the ORIGINAL promise (untouched) for each
   * deferred key — this is what the server-rendered component receives
   * (contract rule 4), before `render-page.ts` swaps in a timeout-bound
   * wrapper for the wire.
   */
  pageData: Record<string, unknown>;
  /** Deferred key names, in declaration order (contract rule 3). */
  deferredKeys: string[];
};

/**
 * Split a `defer()` call's data into today's plain page data plus the list
 * of top-level keys that are promises — contract rule 2. Resolved keys are
 * additionally checked for a NESTED promise (rule 2's refusal case).
 *
 * Declaration order is `Object.entries`' own order, which for a plain
 * object literal is insertion order — exactly the order the loader wrote
 * `defer({ a, b, c })` in.
 */
export function splitDeferredPageData(data: Record<string, unknown>): SplitDeferredPageData {
  const pageData: Record<string, unknown> = {};
  const deferredKeys: string[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (isThenable(value)) {
      deferredKeys.push(key);
      pageData[key] = value;
      continue;
    }

    assertNoNestedDeferred(value, key);
    pageData[key] = value;
  }

  return { pageData, deferredKeys };
}
