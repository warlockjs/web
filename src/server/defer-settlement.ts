/**
 * Streaming SSR, Stage 2 — turn ONE deferred key's raw promise (whatever the
 * loader returned) into two things the rest of the server pipeline needs:
 *
 *   - `componentPromise`: what the server-rendered component receives
 *     (contract rule 4) — settles with the loader's own value/error, OR with
 *     `DeferTimeoutError` if `web.streaming.deferTimeout` elapses first, so a
 *     component awaiting it (`use()`) is guaranteed to unblock even when the
 *     underlying promise never would.
 *   - `settlement`: a promise of the WIRE shape (contract rule 5) that never
 *     rejects — `render-page.ts` awaits it to know when to write the chunk
 *     script and to gate the response end (contract rule 9), and reports
 *     every failure to the server error sink unconditionally (rule 7).
 *
 * Kept as its own file (single responsibility) because `execute-page-request.ts`
 * needs only `componentPromise` (stage 6, building `pageData`) while
 * `render-page.ts` needs only `settlement` (stage 9, emission) — one module
 * produces both from one input so the two call sites can never disagree about
 * what a "deferred key" resolved to.
 */
import { serializePageError } from "./error-page";
import { reportServerError } from "./report-server-error";
import type { SerializedPageError } from "../components/document-context";

/** Raised when a deferred value does not settle within `web.streaming.deferTimeout`. */
export class DeferTimeoutError extends Error {
  public constructor(key: string, timeoutMs: number) {
    super(`Deferred value "${key}" did not settle within ${timeoutMs}ms.`);
    this.name = "DeferTimeoutError";
  }
}

/** The wire shape a settled deferred value carries — contract rule 5. */
export type DeferSettlement =
  | { ok: true; value: unknown }
  | { ok: false; error: SerializedPageError & { statusCode?: number } };

function toSettlementError(thrown: unknown): DeferSettlement & { ok: false } {
  const serialized = serializePageError(thrown);
  const statusCode = (thrown as { statusCode?: number } | null)?.statusCode;

  return {
    ok: false,
    error: statusCode === undefined ? serialized : { ...serialized, statusCode },
  };
}

/** One key's paired promises — see the module doc above. */
export type DeferredSettlementPair = {
  componentPromise: Promise<unknown>;
  settlement: Promise<DeferSettlement>;
};

/**
 * Wrap ONE deferred key's raw promise with a settle-once timeout race.
 *
 * Both output promises settle EXACTLY ONCE, from whichever happens first —
 * the raw promise settling, or the timeout elapsing — and never reject
 * unhandled: `componentPromise` is given an inert `.catch()` immediately so a
 * page that never actually reads a deferred key (no `use()` call at all)
 * cannot produce an unhandled rejection warning.
 */
export function createDeferredSettlement(
  key: string,
  rawPromise: Promise<unknown>,
  timeoutMs: number,
): DeferredSettlementPair {
  let settled = false;

  let resolveSettlement!: (value: DeferSettlement) => void;
  const settlement = new Promise<DeferSettlement>((resolve) => {
    resolveSettlement = resolve;
  });

  let resolveComponent!: (value: unknown) => void;
  let rejectComponent!: (reason: unknown) => void;
  const componentPromise = new Promise<unknown>((resolve, reject) => {
    resolveComponent = resolve;
    rejectComponent = reject;
  });
  componentPromise.catch(() => undefined);

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;

    const timeoutError = new DeferTimeoutError(key, timeoutMs);
    const settlementError = toSettlementError(timeoutError);
    resolveSettlement(settlementError);
    rejectComponent(timeoutError);
    // Rule 7: every timeout goes to the server error sink UNCONDITIONALLY —
    // never gated on whether anything downstream ever reads the settlement.
    // The error's own `errorCode` (production only) is folded into this same
    // report line so an operator can join the two.
    reportServerError(
      `deferred value "${key}" timed out` +
        (settlementError.error.errorCode ? ` (errorCode ${settlementError.error.errorCode})` : ""),
      timeoutError,
    );
  }, timeoutMs);

  // A timer this pipeline holds open must never be the reason a Node process
  // (or a vitest run) hangs waiting for it — the deferred value settling for
  // real, or the request ending first, is what should decide that, not this
  // handle merely existing.
  timer.unref?.();

  Promise.resolve(rawPromise).then(
    (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveSettlement({ ok: true, value });
      resolveComponent(value);
    },
    (thrown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const settlementError = toSettlementError(thrown);
      resolveSettlement(settlementError);
      rejectComponent(thrown);
      // Rule 7: every rejection goes to the server error sink UNCONDITIONALLY.
      // The error's own `errorCode` (production only) is folded into this
      // same report line so an operator can join the two.
      reportServerError(
        `deferred value "${key}" rejected` +
          (settlementError.error.errorCode
            ? ` (errorCode ${settlementError.error.errorCode})`
            : ""),
        thrown,
      );
    },
  );

  return { componentPromise, settlement };
}
