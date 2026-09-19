/**
 * Streaming SSR, Stage 2 — write each deferred key's settlement onto the
 * SAME wire the document's shell already streamed on (contract rules 5-6, 9).
 *
 * WHERE the chunks are written, and why: `render-page.ts`'s
 * `renderElementToPipeableStream` hands back a real React `PipeableStream`
 * whose only public surface is `pipe(destination)`/`abort(reason)` — there is
 * no event to subscribe to for "the shell has flushed" or "the whole tree is
 * done" from OUTSIDE that call. This file splices a `PassThrough` between
 * React's stream and the real destination:
 *
 *   pipeableStream --(react's own writes)--> shell (PassThrough) --> destination
 *
 * `shell`'s readable side firing `"end"` is the ONE externally observable
 * signal that every byte React ever intended to write has already been
 * handed to `destination` — Node's `pipe()` only advances past backpressure
 * once the destination has accepted the previous chunk, so by the time
 * `shell` ends, `destination.write()` has already been called (in order) for
 * everything React produced. Only past that point does this file call
 * `destination.write()` itself, which is what makes "the chunk script never
 * lands inside the shell's own HTML" true regardless of how many ticks the
 * shell took to flush.
 *
 * The alternative the design doc also named — writing straight to the
 * response after `onShellReady` fires, with no Transform — was rejected
 * because `onShellReady` only means REACT IS READY TO START piping; it does
 * not mean the bytes have actually reached `destination` yet (react may still
 * be mid-write, or streaming further Suspense-boundary content the caller
 * never asked to wait for). Writing there risks interleaving a defer chunk
 * into the middle of the shell's own HTML. The Transform makes "flushed" an
 * observable event instead of a guess.
 *
 * `destination.end()` is called only once BOTH react's own stream (`shell`)
 * has ended and this file's own settlement writes are done — see
 * `wrapPipeableStreamForDeferredEmission`'s `allReady` parameter and contract
 * rule 9.
 */
import { PassThrough } from "node:stream";
import type { PipeableStream } from "react-dom/server";
import { stringify } from "devalue";
import { escapePayload } from "../components/document-context";
import { DEFER_BOOTSTRAP_SOURCE } from "../client/runtime/defer-registry";
import { serializePageError } from "./error-page";
import { reportServerError } from "./report-server-error";
import type { ServerErrorContext } from "./error-reporting-config";
import type { DeferSettlement } from "./defer-settlement";
import { assertPageDataSerializable } from "./page-data-serialization-error";
import { ClientDisconnectedError } from "./client-disconnected-error";

/** One deferred key paired with its (never-rejecting) wire-shape settlement. */
export type DeferredEmissionEntry = {
  key: string;
  settlement: Promise<DeferSettlement>;
};

export type WrapPipeableStreamOptions = {
  pipeableStream: PipeableStream;
  /** In DECLARATION order — contract rule 3. Chunks still WRITE in settlement order; see below. */
  deferred: readonly DeferredEmissionEntry[];
  nonce: string | undefined;
  /** Resolves once React's own `onAllReady` has fired — contract rule 9. */
  allReady: Promise<void>;
  /** The matched route's name — carried only for a named `PageDataSerializationError`. */
  routeName: string;
  /** The matched route's own TEMPLATE path — reporting context only (card 1db238ca). */
  routePath?: string;
  /** The request's decoded path, no query — reporting context only (card 1db238ca). */
  pathname?: string;
  /** The request's HTTP method — reporting context only (card 1db238ca). */
  method?: string;
  /** Core's per-request correlation id — reporting context only (card 1db238ca). */
  requestId?: string;
  /**
   * The ONE per-request abort signal (`request-abort-signal.ts`, carried on
   * `PageDataBundle.abortSignal`) — fires when the client disconnects before
   * this stream finished. On fire: the underlying React stream is aborted
   * exactly once, no further deferred chunk is written, and the destination
   * is ended exactly once (card a84d0644). Undefined only for a caller that
   * never went through the request pipeline (a standalone/test render).
   */
  signal?: AbortSignal;
};

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function scriptTag(nonce: string | undefined, innerScript: string): string {
  const nonceAttribute = nonce === undefined ? "" : ` nonce="${escapeAttribute(nonce)}"`;
  return `<script${nonceAttribute}>${innerScript}</script>`;
}

/**
 * `__WARLOCK_DEFER__(<json key>, <devalue-serialized settlement, as a JSON
 * string literal>)` — contract rule 5, updated for devalue as the page-data
 * wire format.
 *
 * The settlement is devalue's `stringify` output, itself wrapped as a JSON
 * STRING (via `JSON.stringify`) rather than spliced in as raw source: the
 * inline bootstrap (`defer-registry.ts`'s `DEFER_BOOTSTRAP_SOURCE`) cannot
 * import devalue, so it receives a plain string argument and only stores it —
 * `uneval` (executable JS from data) is never used here. The whole argument is
 * then HTML-escaped exactly like the hydration payload script, so a hostile
 * value's `</script>` cannot break out of this chunk either.
 */
function deferCallScript(key: string, settlement: DeferSettlement, routeName: string): string {
  const serializedKey = escapePayload(JSON.stringify(key));

  assertPageDataSerializable(settlement, "page", routeName);
  const serializedSettlement = escapePayload(JSON.stringify(stringify(settlement)));

  return `__WARLOCK_DEFER__(${serializedKey}, ${serializedSettlement})`;
}

/**
 * Wrap a page's pipeable stream so that, after its shell has flushed, one
 * `<script>` chunk per deferred key streams onto the SAME response — in
 * settlement order, only once — and the response ends only once every key
 * has settled and React's own tree has fully resolved.
 *
 * A page with no deferred keys gets its `pipeableStream` back unchanged: this
 * wrapper (and the extra `PassThrough`) exists only for the pages that opted
 * into `defer()`.
 */
export function wrapPipeableStreamForDeferredEmission(
  options: WrapPipeableStreamOptions,
): PipeableStream {
  const { pipeableStream, deferred, nonce, allReady, routeName, signal } = options;
  const { routePath, pathname, method, requestId } = options;
  const reportContext = (phase: string): ServerErrorContext => ({
    kind: "defer",
    phase,
    routeName,
    routePath,
    pathname: pathname ?? "unknown",
    method: method ?? "unknown",
    requestId,
  });

  if (deferred.length === 0) return pipeableStream;

  let destination: NodeJS.WritableStream | undefined;

  // Past the point headers/shell bytes are on the wire, a failure can never
  // attempt a fresh response — the ONLY thing left to guarantee is that
  // `destination.end()` fires exactly once, however emission finishes
  // (success, a deferred key's own rejection, a serialization failure
  // caught below, the writer itself erroring, or the client disconnecting).
  let ended = false;
  const endOnce = (): void => {
    if (ended) return;
    ended = true;
    signal?.removeEventListener("abort", onClientDisconnect);
    destination?.end();
  };

  // Guards the underlying React stream's own `abort()` — it may be reached
  // from a client-disconnect signal AND (via `abort()` below) from whatever
  // called this wrapper's own `.abort()` externally; either way React's
  // `abort()` runs at most once.
  let streamAborted = false;
  const abortOnce = (reason?: unknown): void => {
    if (streamAborted) return;
    streamAborted = true;
    pipeableStream.abort(reason);
  };

  const onClientDisconnect = (): void => {
    // A recognisable reason, not a bare `abortOnce()` — React's own fallback
    // for a reasonless `abort()` ("The render was aborted by the server
    // without a reason.") is indistinguishable from a genuine render
    // failure once it reaches `render-page.ts`'s `onError`. Stamping
    // `ClientDisconnectedError` here lets that callback recognise "the
    // client is gone" and skip the SSR-render-error report (card 0d43c0d6).
    abortOnce(new ClientDisconnectedError());
    endOnce();
  };

  if (signal !== undefined) {
    if (signal.aborted) {
      onClientDisconnect();
    } else {
      signal.addEventListener("abort", onClientDisconnect, { once: true });
    }
  }

  return {
    abort(reason) {
      abortOnce(reason);
      endOnce();
    },

    pipe<Writable extends NodeJS.WritableStream>(target: Writable): Writable {
      destination = target;

      // The client was already gone before piping even started — nothing
      // left to stream, just close out the destination.
      if (ended) {
        target.end();
        return target;
      }

      const shell = new PassThrough();

      target.once("error", (error) => {
        reportServerError(
          "deferred emission's destination stream errored",
          error,
          reportContext("destination-stream-error"),
        );
        endOnce();
      });

      pipeableStream.pipe(shell);
      shell.pipe(target, { end: false });

      const shellFlushed = new Promise<void>((resolveShellFlushed) => {
        shell.once("end", () => resolveShellFlushed());
      });

      const settlementsWritten = shellFlushed.then(async () => {
        // The client disconnected while the shell was still flushing — no
        // deferred chunk is safe to write onto a destination already ended.
        if (streamAborted) return;

        target.write(scriptTag(nonce, DEFER_BOOTSTRAP_SOURCE));

        // Each entry writes independently, the instant ITS OWN settlement
        // resolves — never chained one after another — so the chunk order on
        // the wire is the real settlement order, not declaration order.
        await Promise.all(
          deferred.map(({ key, settlement }) =>
            settlement.then((value) => {
              // A disconnect mid-settlement stops every remaining chunk —
              // the destination this would write to is already ending/ended.
              if (streamAborted) return;

              try {
                target.write(scriptTag(nonce, deferCallScript(key, value, routeName)));
              } catch (thrown) {
                // Headers and the shell are already flushed — this can never
                // become a second response attempt. Settle the key in-band,
                // on the SAME wire shape the client already understands for
                // a rejected deferred value, and report the failure through
                // the same unconditional stderr floor a render-time throw
                // uses (`render-page.ts`'s `reportRenderError`). The error's
                // own `errorCode` (production only) is folded into this same
                // report line so an operator can join the two.
                const error = serializePageError(thrown);
                const errorSettlement: DeferSettlement = { ok: false, error };
                reportServerError(
                  `deferred value "${key}" failed to serialize for emission` +
                    (error.errorCode ? ` (errorCode ${error.errorCode})` : ""),
                  thrown,
                  reportContext("serialize-failed"),
                );
                target.write(scriptTag(nonce, deferCallScript(key, errorSettlement, routeName)));
              }
            }),
          ),
        );
      });

      Promise.all([settlementsWritten, allReady]).then(endOnce, (thrown) => {
        reportServerError(
          "deferred emission failed while writing to the response stream",
          thrown,
          reportContext("emission-write-failed"),
        );
        endOnce();
      });

      return target;
    },
  };
}
