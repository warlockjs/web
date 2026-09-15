import { parse as devalueParse } from "devalue";
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
 * `{ name, message, statusCode? }`, produced once decoded, which
 * cannot import {@link DeferredValueError}) is normalized into a real error
 * class before `use()` ever sees it.
 *
 * `raw` is set only by the inline bootstrap ({@link DEFER_BOOTSTRAP_SOURCE}),
 * which cannot import devalue and so cannot decode the devalue-serialized
 * settlement string it is handed — it can only store it. `raw` is cleared the
 * instant this module (which CAN import devalue) decodes and applies it; see
 * `ensureRuntimeDeferHandlerInstalled`.
 */
type DeferredRegistryEntry = {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
  raw?: string;
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
  __WARLOCK_DEFER__?: (key: string, raw: string) => void;
};

/**
 * Self-contained inline JS, safe inside a `<script nonce>` with no `<script
 * type="module">` and no imports. It defines `window.__WARLOCK_DEFER__(key,
 * raw)` and the `window.__WARLOCK_DEFERRED__` key → entry map (Stage 2
 * implementation contract, rule 6).
 *
 * DEVALUE NOTE: devalue is the page-data wire format, including for a
 * deferred settlement (`defer-emission.ts`'s `deferCallScript`) — but the
 * settlement now arrives as a devalue-serialized STRING argument, not as
 * already-live JS values, and this bootstrap has no import statement to reach
 * for. So it does ZERO decoding: it only stores the raw string on a registry
 * entry (creating a pending one if this key has no entry yet). Decoding with
 * devalue's `parse`, and only then resolving or rejecting, is entirely this
 * module's job — see `ensureRuntimeDeferHandlerInstalled`, which drains any
 * raw string this bootstrap already stored the moment the runtime module
 * (this file) is actually exercised. That is what makes an EARLY chunk — one
 * whose `<script>` runs before this module has loaded — still work: nothing
 * is lost, it just waits as text until something here can decode it.
 */
export const DEFER_BOOTSTRAP_SOURCE = `(function () {
  var deferred = window.__WARLOCK_DEFERRED__;
  if (!deferred) {
    deferred = {};
    window.__WARLOCK_DEFERRED__ = deferred;
  }

  function noop() {}

  window.__WARLOCK_DEFER__ = function (key, raw) {
    var entry = deferred[key];

    if (!entry) {
      var resolve, reject;
      var promise = new Promise(function (res, rej) {
        resolve = res;
        reject = rej;
      });
      // Consumed later by this module's own handler; this only stops a
      // transient unhandled-rejection warning before that happens.
      promise.catch(noop);
      entry = { promise: promise, resolve: resolve, reject: reject, settled: false };
      deferred[key] = entry;
    }

    entry.raw = raw;
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

/** Decode one devalue-serialized settlement string — the runtime's only decode point. */
function decodeSettlement(raw: string): DeferredSettlement {
  return devalueParse(raw) as DeferredSettlement;
}

/** Apply an already-decoded settlement to a registry entry — shared by every settle path. */
function applyDecodedSettlement(entry: DeferredRegistryEntry, settlement: DeferredSettlement): void {
  entry.settled = true;
  entry.raw = undefined;

  if (settlement.ok) {
    entry.resolve(settlement.value);
  } else {
    entry.reject(settlement.error);
  }
}

/**
 * (Re)installs the DECODING `window.__WARLOCK_DEFER__`, and immediately
 * drains any raw settlement string the inline bootstrap has already stored
 * (an early chunk, or several) for a key this module has not touched yet.
 *
 * Called at the start of every runtime entry point below
 * (`prepareDeferredPageData`, `settleDeferredValue`, the stream-closed
 * rejection paths) so this module is always the authority on
 * `window.__WARLOCK_DEFER__` from the moment any of them runs, regardless of
 * whether the inline bootstrap ran first (the ordinary page-load case — a
 * `type="module"` script only executes once the document has finished
 * parsing, by which point every bootstrap chunk has already run) or not at
 * all yet.
 */
function ensureRuntimeDeferHandlerInstalled(): void {
  const target = getWarlockWindow();
  const registry = getOrCreateRegistry();

  for (const key of Object.keys(registry)) {
    const entry = registry[key];

    if (entry !== undefined && entry.raw !== undefined && !entry.settled) {
      const raw = entry.raw;

      applyDecodedSettlement(entry, decodeSettlement(raw));
    }
  }

  target.__WARLOCK_DEFER__ = (key: string, raw: string) => {
    let entry = registry[key];

    if (entry === undefined) {
      entry = createPendingEntry();
      registry[key] = entry;
    }

    applyDecodedSettlement(entry, decodeSettlement(raw));
  };
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
 * `{ name, message, statusCode? }` settlement error (decoded from devalue
 * text, which carries plain data, never a live `Error` instance) is wrapped
 * into one.
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
  ensureRuntimeDeferHandlerInstalled();

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

/**
 * Settle one key from an ALREADY-DECODED settlement — the non-DOM equivalent
 * of `window.__WARLOCK_DEFER__`, for a consumer that receives settlements
 * from something other than an inline `<script>` (Stage 2 slice S3: the
 * NDJSON client-navigation reader, `web/src/client/navigation/fetch-page-data.ts`,
 * which devalue-decodes the settlement itself off the wire and has nothing
 * left to decode here).
 *
 * Mirrors the bootstrap/decode pipeline's own behaviour exactly, so a key
 * settled through either entry point behaves identically: a key with no
 * existing entry (a settlement that arrives before {@link prepareDeferredPageData}
 * has run for it) gets a pending entry created and settled immediately; an
 * existing pending entry is resolved or rejected in place.
 */
export function settleDeferredValue(key: string, settlement: DeferredSettlement): void {
  ensureRuntimeDeferHandlerInstalled();

  const registry = getOrCreateRegistry();
  let entry = registry[key];

  if (entry === undefined) {
    entry = createPendingEntry();
    registry[key] = entry;
  }

  applyDecodedSettlement(entry, settlement);
}

/**
 * Reject specific still-pending keys IMMEDIATELY, rather than waiting for
 * `DOMContentLoaded` (Stage 2 slice S3's own "stream closed" case: an NDJSON
 * client-navigation response that ends with keys still outstanding, contract
 * rule 8 applied to a navigation instead of the hydration document).
 *
 * A key already settled, or with no entry at all, is left untouched — this is
 * the same idempotence {@link installStreamClosedRejection} gives the
 * hydration path, applied to an explicit key list instead of "everything
 * still pending right now".
 */
export function rejectPendingDeferredKeys(keys: readonly string[]): void {
  ensureRuntimeDeferHandlerInstalled();

  const registry = getOrCreateRegistry();

  for (const key of keys) {
    const entry = registry[key];

    if (entry !== undefined && !entry.settled) {
      entry.settled = true;
      entry.reject(new DeferredStreamClosedError(key));
    }
  }
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
    ensureRuntimeDeferHandlerInstalled();

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
