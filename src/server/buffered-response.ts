import type { LoaderShortCircuit, WebResponse } from "../context";

/**
 * The per-loader response facade for pipeline stage 6.
 *
 * Loaders run in PARALLEL and never see the real `Response`: core's
 * `Response.header`/`cookie` write straight through to the fastify reply
 * (core/src/http/response.ts:919-923, :955-967), so three concurrent loaders
 * writing directly would interleave nondeterministically and a discarded
 * layer's writes could never be taken back. Instead each loader gets one of
 * these facades; every write lands in a buffer, and the pipeline's
 * settle/commit stage applies the surviving buffers to
 * the real response root→leaf, per cookie name / header key.
 */

export type BufferedHeader = {
  key: string;
  value: string;
};

export type BufferedCookie = {
  name: string;
  value: unknown;
  options?: Record<string, unknown>;
};

export type ResponseBuffer = {
  headers: BufferedHeader[];
  cookies: BufferedCookie[];
  statusCode?: number;
};

/**
 * Runtime brand behind `LoaderShortCircuit` (web/src/context.ts:13-17
 * declares the compile-time half). A loader RETURNS this from
 * `response.redirect()` / `response.notFound()`; the settle stage detects it
 * by the symbol, never by shape.
 */
export const LOADER_SHORT_CIRCUIT = Symbol("warlock.loader.shortCircuit");

export type LoaderShortCircuitSignal = LoaderShortCircuit & {
  kind: "redirect" | "notFound";
  statusCode: number;
  url?: string;
  body?: unknown;
};

export function isLoaderShortCircuit(value: unknown): value is LoaderShortCircuitSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[LOADER_SHORT_CIRCUIT] === true
  );
}

function shortCircuitSignal(
  init: Omit<LoaderShortCircuitSignal, keyof LoaderShortCircuit>,
): LoaderShortCircuitSignal {
  return { ...init, [LOADER_SHORT_CIRCUIT]: true } as unknown as LoaderShortCircuitSignal;
}

/**
 * The loader-facing surface is `WebResponse` (web/src/context.ts:73-88) plus
 * `cookie()`, which the commit contract needs so buffers can be applied
 * per cookie name.
 */
export type BufferedWebResponse = WebResponse & {
  cookie(name: string, value: unknown, options?: Record<string, unknown>): BufferedWebResponse;
};

export function createBufferedResponse(): {
  response: BufferedWebResponse;
  buffer: ResponseBuffer;
} {
  const buffer: ResponseBuffer = { headers: [], cookies: [] };

  const response: BufferedWebResponse = {
    header(key: string, value: string) {
      buffer.headers.push({ key, value });
      return response;
    },

    cookie(name: string, value: unknown, options?: Record<string, unknown>) {
      buffer.cookies.push({ name, value, options });
      return response;
    },

    setStatusCode(statusCode: number) {
      buffer.statusCode = statusCode;
      return response;
    },

    /**
     * A redirect is a status AND a `Location`; both belong in the buffer.
     *
     * Writing only `buffer.statusCode` here and carrying the URL out on the
     * branded return value split one answer across two channels, and the
     * emit only ever drained the first: the document path applied
     * `bundle.commit.headers` and never read `bundle.shortCircuit`, so the
     * browser got a bare `302` with an empty body and stayed put
     * (design/loader-endpoint-seam-2026-08-23.md §5).
     *
     * Putting `Location` in the buffer fixes it once, at the declaration,
     * for every consumer: the commit stage's live mirror
     * (`execute-page-request.ts` commitBuffers — which mirrors headers and
     * status only; its cookie half was removed so `Set-Cookie` is not
     * appended twice, and `Location` rides the header half),
     * `bundle.commit.headers`, `finishRender`'s header map, and the handler's
     * `response.headers()` all carry it without any of them learning what a
     * redirect is. The
     * alternative — special-casing `shortCircuit.kind` at the emit — would
     * have to be re-implemented by every emit path that ever exists, which
     * is precisely how this shipped unnoticed the first time.
     *
     * The signal is still returned and still branded: the buffer says what
     * the response should LOOK like, the signal says the pipeline must STOP.
     * Those are different facts and both are still needed.
     */
    redirect(url: string, statusCode = 302) {
      buffer.statusCode = statusCode;
      buffer.headers.push({ key: "Location", value: url });
      return shortCircuitSignal({ kind: "redirect", statusCode, url });
    },

    /** Same shape as `redirect`, at 301 — deliberately not special-cased. */
    permanentRedirect(url: string) {
      buffer.statusCode = 301;
      buffer.headers.push({ key: "Location", value: url });
      return shortCircuitSignal({ kind: "redirect", statusCode: 301, url });
    },

    /**
     * The other short-circuit kind. It shares the signal shape but has no
     * URL, so it writes no `Location` — a 404 that redirects is not a thing.
     */
    notFound(body?: unknown) {
      buffer.statusCode = 404;
      return shortCircuitSignal({ kind: "notFound", statusCode: 404, body });
    },
  };

  return { response, buffer };
}
