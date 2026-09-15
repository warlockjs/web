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
import type { DeferSettlement } from "./defer-settlement";
import { assertPageDataSerializable } from "./page-data-serialization-error";

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
  const { pipeableStream, deferred, nonce, allReady, routeName } = options;

  if (deferred.length === 0) return pipeableStream;

  return {
    abort(reason) {
      pipeableStream.abort(reason);
    },

    pipe<Writable extends NodeJS.WritableStream>(destination: Writable): Writable {
      const shell = new PassThrough();

      pipeableStream.pipe(shell);
      shell.pipe(destination, { end: false });

      const shellFlushed = new Promise<void>((resolveShellFlushed) => {
        shell.once("end", () => resolveShellFlushed());
      });

      const settlementsWritten = shellFlushed.then(async () => {
        destination.write(scriptTag(nonce, DEFER_BOOTSTRAP_SOURCE));

        // Each entry writes independently, the instant ITS OWN settlement
        // resolves — never chained one after another — so the chunk order on
        // the wire is the real settlement order, not declaration order.
        await Promise.all(
          deferred.map(({ key, settlement }) =>
            settlement.then((value) => {
              destination.write(scriptTag(nonce, deferCallScript(key, value, routeName)));
            }),
          ),
        );
      });

      Promise.all([settlementsWritten, allReady]).then(() => {
        destination.end();
      });

      return destination;
    },
  };
}
