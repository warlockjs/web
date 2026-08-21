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
 * settle/commit stage (canon 20c425dd §10) applies the surviving buffers to
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
 * `cookie()`, which the commit contract needs ("per cookie name",
 * canon 20c425dd §10) though the M1 declaration had not named it yet.
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

    redirect(url: string, statusCode = 302) {
      buffer.statusCode = statusCode;
      return shortCircuitSignal({ kind: "redirect", statusCode, url });
    },

    permanentRedirect(url: string) {
      buffer.statusCode = 301;
      return shortCircuitSignal({ kind: "redirect", statusCode: 301, url });
    },

    notFound(body?: unknown) {
      buffer.statusCode = 404;
      return shortCircuitSignal({ kind: "notFound", statusCode: 404, body });
    },
  };

  return { response, buffer };
}
