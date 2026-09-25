import { randomUUID } from "node:crypto";
import { environment, type Response } from "@warlock.js/core";
import { isVisitorSafePageError } from "./is-visitor-safe-page-error";
import { reportServerError } from "./report-server-error";
import type { ServerErrorContext } from "./error-reporting-config";
import type {
  PageBoundaryDesignation,
  PageErrorRecord,
  PageLevelName,
  PageRouteEntry,
} from "./execute-page-request.types";

/** Reporting context `buildErrorRecord`'s caller hands over purely for `web.errors.report()` (card 1db238ca). */
export type BuildErrorRecordReportContext = {
  routeName?: string;
  routePath?: string;
  method?: string;
  requestId?: string;
};

export const LEVEL_ORDER: readonly PageLevelName[] = ["app", "layout", "page"];

export function designateBoundary(
  throwingLevel: PageLevelName,
  triple: PageRouteEntry["triple"],
): PageBoundaryDesignation {
  const throwingIndex = LEVEL_ORDER.indexOf(throwingLevel);

  for (let index = throwingIndex; index >= 0; index--) {
    const level = LEVEL_ORDER[index];
    if (level === undefined) continue;

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
  statusCode?: number,
  reportContext?: BuildErrorRecordReportContext,
  report: boolean = true,
): PageErrorRecord {
  const digest = randomUUID();
  const errorContext: ServerErrorContext = {
    kind: "loader",
    phase: boundary.throwingLevel,
    routeName: reportContext?.routeName,
    routePath: reportContext?.routePath,
    pathname: requestPath ?? "unknown",
    method: reportContext?.method ?? "unknown",
    statusCode,
    requestId: reportContext?.requestId,
  };

  // A resolved 4xx (card f2b8953d) is the visitor's own affair, not a server
  // fault — it skips both the stderr floor and `web.errors.report()` that
  // `reportServerError` always drives, and gets at most a debug breadcrumb.
  if (report) {
    reportServerError(
      `page error ${digest}${requestPath ? ` (${requestPath})` : ""}`,
      thrown,
      errorContext,
    );
  } else {
    console.debug(
      `[warlock:web] page error ${digest}${requestPath ? ` (${requestPath})` : ""}:`,
      thrown,
    );
  }

  // A visitor-safe error (PublicPageError, PageValidationFailedError) keeps
  // its own content even in production — the
  // same rule `serializePageError` (`./error-page.ts`) applies at the
  // hydration boundary; this is the loader/middleware-throw boundary's own
  // enforcement point, so the two never disagree about what "public" means.
  if (environment() === "production" && !isVisitorSafePageError(thrown)) {
    const surrogate = new Error("An unexpected error occurred.");

    (surrogate as Error & { digest: string }).digest = digest;

    return {
      originalError: thrown,
      error: surrogate,
      boundary,
      digest,
      scrubbed: true,
      statusCode,
    };
  }

  // `error` already IS the real thrown value here — `originalError` only ever
  // needs to diverge from it on the scrubbed (production) path above. Leaving
  // it `undefined` rather than a redundant second reference to the same object
  // keeps the record's `toEqual` shape honest (undefined properties compare as
  // absent) and readers still get the real error via
  // `record.originalError ?? record.error`.
  return { originalError: undefined, error: thrown, boundary, digest, scrubbed: false, statusCode };
}

// ---------------------------------------------------------------------------
// Stage 6/7 — buffered per-level responses, and the root→leaf commit
// ---------------------------------------------------------------------------

/** A single committed response header, in application order. */
export type BufferedHeader = { key: string; value: string };

/**
 * A single committed response cookie — the shape `applyBufferedCookie` replays.
 * `clear` marks a deletion, replayed through `response.clearCookie()`.
 */
export type BufferedCookie = {
  name: string;
  value: unknown;
  options?: Record<string, unknown>;
  clear?: true;
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
  clearCookie(name: string, options?: Record<string, unknown>): BufferedResponse;
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
    clearCookie(name, options) {
      buffer.cookies.push({ name, value: "", options, clear: true });
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
      return {
        [LOADER_SHORT_CIRCUIT]: true,
        kind: "notFound",
        statusCode: 404,
        url: undefined,
        body,
      };
    },
  };

  return bufferedResponse;
}

// ---------------------------------------------------------------------------
// Page actions — the response surface an `action` sees (5.21 card A5)
// ---------------------------------------------------------------------------

const ACTION_FAILURE = Symbol("warlock.page.actionFailure");

/** Failure helpers an action's response offers, with their HTTP status. */
export const ACTION_FAILURE_STATUS = {
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  conflict: 409,
  unprocessableEntity: 422,
  tooManyRequests: 429,
  serviceUnavailable: 503,
} as const;

export type ActionFailureName = keyof typeof ACTION_FAILURE_STATUS;

/**
 * What an `ActionResponse` failure helper returns — branded by symbol (never
 * by shape), like `LoaderShortCircuitSignal`. `payload` is the optional
 * `{ message, errors }` (or any data) the action handed the helper.
 */
export type ActionFailureSignal = {
  readonly [ACTION_FAILURE]: true;
  kind: "failure";
  helper: ActionFailureName;
  statusCode: number;
  payload?: unknown;
};

export function isActionFailure(value: unknown): value is ActionFailureSignal {
  return Boolean(value) && typeof value === "object" && ACTION_FAILURE in (value as object);
}

/**
 * The buffered response an ACTION sees: everything `BufferedResponse` offers
 * plus the named failure helpers. Each queues its status on the
 * buffer and returns a branded signal the action returns.
 */
export type ActionResponse = BufferedResponse & {
  [Name in ActionFailureName]: (payload?: unknown) => ActionFailureSignal;
};

export function createActionResponse(buffer: LevelBuffer): ActionResponse {
  const actionResponse = createBufferedResponse(buffer) as ActionResponse;

  for (const helper of Object.keys(ACTION_FAILURE_STATUS) as ActionFailureName[]) {
    const statusCode = ACTION_FAILURE_STATUS[helper];

    actionResponse[helper] = (payload) => {
      buffer.statusCode = statusCode;

      return { [ACTION_FAILURE]: true, kind: "failure", helper, statusCode, payload };
    };
  }

  return actionResponse;
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

  const headers = headerOrder.map((key) => headerMap.get(key)!);
  const cookies = cookieOrder.map((name) => cookieMap.get(name)!);

  for (const header of headers) response.header(header.key, header.value);
  if (statusCode !== undefined) response.setStatusCode(statusCode);

  return { committedLevels, headers, cookies, statusCode };
}
