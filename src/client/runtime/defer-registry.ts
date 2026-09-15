import { DeferredStreamClosedError } from "./deferred-stream-closed-error";
import { DeferredValueError } from "./deferred-value-error";

/**
 * The wire-safe settlement shape for one deferred key (Stage 2 implementation
 * contract, rule 5). `error` never carries a stack in production; dev may add
 * one, which this client deliberately ignores — {@link DeferredValueError}
 * only reads `message`/`statusCode`.
 */
export type DeferredSettlement =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly error: { readonly name: string; readonly message: string; readonly statusCode?: number };
    };

/**
 * One entry of the client-side registry: the RAW promise `__WARLOCK_DEFER__`
 * settles, plus its resolve/reject pair and a `settled` flag.
 *
 * This raw promise is deliberately never handed out directly —
 * {@link prepareDeferredPageData} wraps it so a raw settlement error (a plain
 * `{ name, message, statusCode? }`, produced by the inline bootstrap, which
 * cannot import {@link DeferredValueError}) is normalized into a real error
 * class before `use()` ever sees it.
 */
type DeferredRegistryEntry = {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
};

type DeferredRegistryMap = Record<string, DeferredRegistryEntry>;

/**
 * The two globals the inline bootstrap ({@link DEFER_BOOTSTRAP_SOURCE}) and
 * this module both read and write. Declared as a `window` narrowing rather
 * than a global augmentation so this file stays the one place that types
 * them.
 */
type WarlockDeferredWindow = typeof globalThis & {
  __WARLOCK_DEFERRED__?: DeferredRegistryMap;
  __WARLOCK_DEFER__?: (key: string, settlement: DeferredSettlement) => void;
};

/**
 * Self-contained inline JS, safe inside a `<script nonce>` with no `<script
 * type="module">` and no imports. It defines `window.__WARLOCK_DEFER__(key,
 * settlement)` and the `window.__WARLOCK_DEFERRED__` key → entry map (Stage 2
 * implementation contract, rule 6).
 *
 * DEVALUE NOTE (see also the module-level comment below): this bootstrap does
 * zero decoding. The contract's wire format calls
 * `__WARLOCK_DEFER__(<json-string key>, <serialized settlement>)` as an
 * inlined script — the settlement is embedded as JS source, not as a string
 * to parse, so by the time this function runs the JS engine has already
 * turned it into a real value. There is nothing left to deserialize.
 *
 * A call for a key with no existing entry (an early chunk, arriving before
 * {@link prepareDeferredPageData} has run) creates an ALREADY-SETTLED entry
 * directly from the settlement, with no-op resolve/reject — nothing will
 * call them again. A call for an existing (pending) entry resolves or
 * rejects it with the settlement's raw `value`/`error`; normalizing a raw
 * `error` into a {@link DeferredValueError} happens later, in
 * `prepareDeferredPageData`, which is the first point in this pipeline that
 * can import that class.
 */
export const DEFER_BOOTSTRAP_SOURCE = `(function () {
  var deferred = window.__WARLOCK_DEFERRED__;
  if (!deferred) {
    deferred = {};
    window.__WARLOCK_DEFERRED__ = deferred;
  }

  function noop() {}

  window.__WARLOCK_DEFER__ = function (key, settlement) {
    var entry = deferred[key];

    if (!entry) {
      var promise;
      if (settlement && settlement.ok) {
        promise = Promise.resolve(settlement.value);
      } else {
        promise = Promise.reject(settlement && settlement.error);
      }
      // Consumed later by prepareDeferredPageData's own handler; this only
      // stops a transient unhandled-rejection warning before that happens.
      promise.catch(noop);
      deferred[key] = { promise: promise, resolve: noop, reject: noop, settled: true };
      return;
    }

    entry.settled = true;
    if (settlement && settlement.ok) {
      entry.resolve(settlement.value);
    } else {
      entry.reject(settlement && settlement.error);
    }
  };
})();`;

function getWarlockWindow(): WarlockDeferredWindow {
  return window as WarlockDeferredWindow;
}

/** Reads (creating if absent) the same map the inline bootstrap writes to. */
function getOrCreateRegistry(): DeferredRegistryMap {
  const target = getWarlockWindow();

  if (target.__WARLOCK_DEFERRED__ === undefined) {
    target.__WARLOCK_DEFERRED__ = {};
  }

  return target.__WARLOCK_DEFERRED__;
}

function createPendingEntry(): DeferredRegistryEntry {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;

  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  // A permanent silent handler so a later rejection (via __WARLOCK_DEFER__ or
  // installStreamClosedRejection) never surfaces as an unhandled-rejection
  // warning just because `use()` has not attached its own handler yet. It
  // does not affect the derived promise prepareDeferredPageData hands out —
  // every `.then`/`.catch` attached to `promise` still fires independently.
  promise.catch(() => undefined);

  return { promise, resolve, reject, settled: false };
}

function isErrorLike(
  value: unknown,
): value is { name: string; message: string; statusCode?: number } {
  return (
    typeof value === "object" && value !== null && typeof (value as { message?: unknown }).message === "string"
  );
}

/**
 * Turns a raw rejection reason into a real error instance for `use()`. A
 * reason that is already an `Error` (e.g. a {@link DeferredStreamClosedError}
 * installed directly by this module) passes through unchanged; a raw
 * `{ name, message, statusCode? }` settlement error (produced by the inline
 * bootstrap, which cannot construct {@link DeferredValueError} itself) is
 * wrapped into one.
 */
function normalizeRejection(reason: unknown): unknown {
  if (reason instanceof Error) return reason;
  if (isErrorLike(reason)) return new DeferredValueError(reason.message, reason.statusCode);

  return new DeferredValueError("A deferred loader value failed with no error details.");
}

/**
 * Before hydration, replaces `pageData[key]` with a registry-backed promise
 * for each deferred key — pre-creating a pending registry entry for any key
 * an early chunk has not already settled (Stage 2 implementation contract,
 * rules 4 and 6). Mutates and returns the same `pageData` object.
 *
 * The promise placed in `pageData[key]` is a derived one, not the registry's
 * raw promise: its rejection path normalizes a raw settlement error into a
 * {@link DeferredValueError} (or passes an already-real `Error` through
 * unchanged), so `use()` always throws a proper error instance.
 */
export function prepareDeferredPageData(
  pageData: Record<string, unknown>,
  deferredKeys: readonly string[],
): Record<string, unknown> {
  const registry = getOrCreateRegistry();

  for (const key of deferredKeys) {
    let entry = registry[key];

    if (entry === undefined) {
      entry = createPendingEntry();
      registry[key] = entry;
    }

    pageData[key] = entry.promise.then(
      (value) => value,
      (reason) => {
        throw normalizeRejection(reason);
      },
    );
  }

  return pageData;
}

let streamClosedRejectionInstalled = false;

/**
 * Rejects every still-pending deferred key with {@link DeferredStreamClosedError}
 * once the document finishes loading — the stream ended without a chunk for
 * them (Stage 2 implementation contract, rule 8). No hard navigation
 * follows.
 *
 * Idempotent: only the first call installs the listener (or, if the document
 * has already finished loading, rejects immediately); every later call is a
 * no-op.
 */
export function installStreamClosedRejection(): void {
  if (streamClosedRejectionInstalled) return;
  streamClosedRejectionInstalled = true;

  const rejectStillPending = (): void => {
    const registry = getOrCreateRegistry();

    for (const key of Object.keys(registry)) {
      const entry = registry[key];

      if (entry !== undefined && !entry.settled) {
        entry.settled = true;
        entry.reject(new DeferredStreamClosedError(key));
      }
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", rejectStillPending, { once: true });
  } else {
    rejectStillPending();
  }
}
