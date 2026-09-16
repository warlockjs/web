import { Writable } from "node:stream";

/** The part of React's `PipeableStream` this helper needs. */
export type CollectablePipeableStream = {
  pipe<Destination extends NodeJS.WritableStream>(destination: Destination): Destination;
};

/**
 * Drains a React server stream into one UTF-8 string.
 *
 * Used when the page cache stores a MISS: the stored entry must be the exact
 * document the visitor received, and that document only exists as a stream.
 * The caller forces `onAllReady` first, so the stream holds no pending
 * Suspense boundaries and no deferred chunks.
 */
export function collectPipeableStream(stream: CollectablePipeableStream): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];

    const sink = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        callback();
      },
    });

    sink.on("finish", () => resolve(Buffer.concat(chunks).toString("utf8")));
    sink.on("error", reject);

    stream.pipe(sink);
  });
}
