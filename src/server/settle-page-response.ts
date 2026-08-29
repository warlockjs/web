import { randomUUID } from "node:crypto";
import type { Response } from "@warlock.js/core";
import type {
  PageBoundaryDesignation,
  PageErrorRecord,
  PageLevelName,
  PageRouteEntry,
} from "./execute-page-request.types";

export const LEVEL_ORDER: readonly PageLevelName[] = ["app", "layout", "page"];

export function designateBoundary(
  throwingLevel: PageLevelName,
  triple: PageRouteEntry["triple"],
): PageBoundaryDesignation {
  const throwingIndex = LEVEL_ORDER.indexOf(throwingLevel);

  for (let index = throwingIndex; index >= 0; index--) {
    const level = LEVEL_ORDER[index];

    if (triple[level].ErrorBoundary) {
      return { throwingLevel, boundaryLevel: level };
    }
  }

  return { throwingLevel, boundaryLevel: "app" };
}

export function buildErrorRecord(
  thrown: unknown,
  boundary: PageBoundaryDesignation,
  requestPath?: string,
): PageErrorRecord {
  const digest = randomUUID();

  console.error("[warlock] page error", digest, ...(requestPath ? [requestPath] : []), thrown);

  if (process.env.NODE_ENV === "production") {
    const surrogate = new Error("An unexpected error occurred.");

    (surrogate as Error & { digest: string }).digest = digest;

    return { originalError: thrown, error: surrogate, boundary, digest, scrubbed: true };
  }

  // `error` already IS the real thrown value here — `originalError` only ever
  // needs to diverge from it on the scrubbed (production) path above. Leaving
  // it `undefined` rather than a redundant second reference to the same object
  // keeps the record's `toEqual` shape honest (undefined properties compare as
  // absent) and readers still get the real error via
  // `record.originalError ?? record.error`.
  return { originalError: undefined, error: thrown, boundary, digest, scrubbed: false };
}

// ---------------------------------------------------------------------------
// Stage 6/7 — buffered per-level responses, and the root→leaf commit
// ---------------------------------------------------------------------------

/** A single committed response header, in application order. */
export type BufferedHeader = { key: string; value: string };

/** A single committed response cookie — the shape `applyBufferedCookie` replays. */
export type BufferedCookie = {
  name: string;
  value: unknown;
  options?: Record<string, unknown>;
};

/** The two loader short-circuit kinds a buffered response can signal. */
export type LoaderShortCircuitKind = "redirect" | "notFound";

const LOADER_SHORT_CIRCUIT = Symbol("warlock.page.loaderShortCircuit");

/**
 * What `response.redirect()` / `response.permanentRedirect()` / `response.notFound()`
 * return from inside a loader — a branded value the stage 7 settle scan
 * recognises by symbol, never by shape (so an app returning an
 * accidentally-similar plain object can't be mistaken for one).
 */
export type LoaderShortCircuitSignal = {
  readonly [LOADER_SHORT_CIRCUIT]: true;
  kind: LoaderShortCircuitKind;
  statusCode: number;
  url?: string;
  body?: unknown;
};

export function isLoaderShortCircuit(value: unknown): value is LoaderShortCircuitSignal {
  return Boolean(value) && typeof value === "object" && LOADER_SHORT_CIRCUIT in (value as object);
}

/** One level's scratch buffer — what `response.header()`/`.cookie()` write into. */
export type LevelBuffer = {
  headers: BufferedHeader[];
  cookies: BufferedCookie[];
  statusCode?: number;
};

export function createLevelBuffer(): LevelBuffer {
  return { headers: [], cookies: [] };
}

/**
 * The response surface a LOADER sees — never the live core `Response`.
 * `header()`/`cookie()` queue into the level's own buffer; nothing here
 * touches the real reply. `redirect()`/`permanentRedirect()`/`notFound()`
 * queue the buffer's own status (+ `Location`, for the two redirects) AND
 * return the branded signal stage 7 detects — the loader is expected to
 * `return response.redirect(...)`.
 */
export type BufferedResponse = {
  header(key: string, value: unknown): BufferedResponse;
  headers(bag: Record<string, unknown>): BufferedResponse;
  cookie(name: string, value: unknown, options?: Record<string, unknown>): BufferedResponse;
  setStatusCode(statusCode: number): BufferedResponse;
  redirect(url: string, statusCode?: number): LoaderShortCircuitSignal;
  permanentRedirect(url: string): LoaderShortCircuitSignal;
  notFound(body?: unknown): LoaderShortCircuitSignal;
};

export function createBufferedResponse(buffer: LevelBuffer): BufferedResponse {
  const bufferedResponse: BufferedResponse = {
    header(key, value) {
      buffer.headers.push({ key, value: String(value) });
      return bufferedResponse;
    },
    headers(bag) {
      for (const [key, value] of Object.entries(bag)) bufferedResponse.header(key, value);
      return bufferedResponse;
    },
    cookie(name, value, options) {
      buffer.cookies.push({ name, value, options });
      return bufferedResponse;
    },
    setStatusCode(statusCode) {
      buffer.statusCode = statusCode;
      return bufferedResponse;
    },
    redirect(url, statusCode = 302) {
      buffer.statusCode = statusCode;
      buffer.headers.push({ key: "Location", value: url });
      return { [LOADER_SHORT_CIRCUIT]: true, kind: "redirect", statusCode, url, body: undefined };
    },
    permanentRedirect(url) {
      return bufferedResponse.redirect(url, 301);
    },
    notFound(body) {
      buffer.statusCode = 404;
      return { [LOADER_SHORT_CIRCUIT]: true, kind: "notFound", statusCode: 404, url: undefined, body };
    },
  };

  return bufferedResponse;
}

/** Stage 7's folded, applied result — what `bundle.commit` carries. */
export type PageResponseCommit = {
  committedLevels: PageLevelName[];
  headers: BufferedHeader[];
  cookies: BufferedCookie[];
  statusCode?: number;
};

/**
 * Fold every surviving buffer root→leaf into ONE map per key (header key
 * case-insensitively, cookie by name) — leafward wins, insertion position
 * stays where the key FIRST appeared. Applies the folded headers and status
 * to the REAL response (`header()`/`setStatusCode()` are idempotent keyed
 * sets, so this is safe even though `commitBuffers` can run before render
 * changes its mind about the status later). Cookies are NOT applied to the
 * real response here — `cookie()` APPENDS, so mirroring it here and again at
 * the wire emit would duplicate every `Set-Cookie`. The single application
 * site is the emit (`create-page-route-handler.ts`, via `applyBufferedCookie`
 * over `bundle.commit.cookies`).
 */
export function commitBuffers(
  response: Response,
  buffers: Record<PageLevelName, LevelBuffer>,
  committedLevels: PageLevelName[],
): PageResponseCommit {
  const headerOrder: string[] = [];
  const headerMap = new Map<string, BufferedHeader>();
  const cookieOrder: string[] = [];
  const cookieMap = new Map<string, BufferedCookie>();
  let statusCode: number | undefined;

  for (const level of committedLevels) {
    const buffer = buffers[level];

    for (const header of buffer.headers) {
      const key = header.key.toLowerCase();
      if (!headerMap.has(key)) headerOrder.push(key);
      headerMap.set(key, header);
    }

    for (const cookie of buffer.cookies) {
      if (!cookieMap.has(cookie.name)) cookieOrder.push(cookie.name);
      cookieMap.set(cookie.name, cookie);
    }

    if (buffer.statusCode !== undefined) statusCode = buffer.statusCode;
  }

  const headers = headerOrder.map(key => headerMap.get(key)!);
  const cookies = cookieOrder.map(name => cookieMap.get(name)!);

  for (const header of headers) response.header(header.key, header.value);
  if (statusCode !== undefined) response.setStatusCode(statusCode);

  return { committedLevels, headers, cookies, statusCode };
}
