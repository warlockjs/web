import { randomUUID } from "node:crypto";
import type { BufferedCookie, BufferedHeader, ResponseBuffer } from "./buffered-response";
import type {
  PageBoundaryDesignation,
  PageErrorRecord,
  PageLevelName,
  PageResponseCommit,
  PageRouteEntry,
  PipelineResponse,
} from "./execute-page-request.types";

/** Root → leaf. The pipeline's one ordering, used by every stage that walks levels. */
export const LEVEL_ORDER: readonly PageLevelName[] = ["app", "layout", "page"];

/**
 * Settle the surviving buffers root→leaf, per cookie name / header key: a
 * leafward level re-writing the same key wins it, everything else merges.
 *
 * **Headers and status are mirrored onto the live response here; COOKIES ARE
 * NOT**, and that asymmetry is the fix for a real defect rather than an
 * oversight. `header()` and `setStatusCode()` are keyed SETs, so mirroring here
 * and re-applying at the emit is idempotent. `cookie()` APPENDS — Fastify emits
 * one `Set-Cookie` per call — so doing both put the same cookie on the wire
 * twice, on every page response including the happy path.
 *
 * The emit is the authoritative application site (`createPageRouteHandler`
 * replays `rendered.cookies` through `applyBufferedCookie`), so the cookie loop
 * is the one that goes.
 */
export function commitBuffers(
  realResponse: PipelineResponse,
  ordered: readonly { level: PageLevelName; buffer: ResponseBuffer }[],
  forcedStatusCode?: number,
): PageResponseCommit {
  const headers = new Map<string, BufferedHeader>();
  const cookies = new Map<string, BufferedCookie>();
  let statusCode: number | undefined;

  for (const { buffer } of ordered) {
    for (const header of buffer.headers) headers.set(header.key.toLowerCase(), header);
    for (const cookie of buffer.cookies) cookies.set(cookie.name, cookie);
    if (buffer.statusCode !== undefined) statusCode = buffer.statusCode;
  }

  if (forcedStatusCode !== undefined) statusCode = forcedStatusCode;

  for (const header of headers.values()) realResponse.header(header.key, header.value);
  if (statusCode !== undefined) realResponse.setStatusCode(statusCode);

  // No `realResponse.cookie(...)` loop — see above. Settled cookies leave
  // through the return value only, and the emit applies them exactly once.

  return {
    headers: [...headers.values()],
    cookies: [...cookies.values()],
    statusCode,
    committedLevels: ordered.map(({ level }) => level),
  };
}

/** Nearest `ErrorBoundary` at or rootward of the throw; `app` is terminal. */
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

  // The framework owns a root boundary.
  return { throwingLevel, boundaryLevel: "app" };
}

/**
 * The one place a throw enters the bundle.
 *
 * **Production never lets the raw error reach a client** — the boundary gets a
 * surrogate carrying only `digest`, which is all the reference app's
 * ErrorBoundary renders. Dev keeps the real thrown value so the stack survives,
 * and it is never mutated to attach `digest`: that lives on the RECORD only.
 */
export function buildErrorRecord(
  thrown: unknown,
  boundary: PageBoundaryDesignation,
  requestPath?: string,
): PageErrorRecord {
  const digest = randomUUID();

  // The boundary tells the user this was logged, so log it. A digest that
  // appears in no log is worse than no digest.
  console.error("[warlock] page error", digest, ...(requestPath ? [requestPath] : []), thrown);

  if (process.env.NODE_ENV === "production") {
    const surrogate = new Error("An unexpected error occurred.");

    (surrogate as Error & { digest: string }).digest = digest;

    return { error: surrogate, boundary, digest, scrubbed: true };
  }

  return { error: thrown, boundary, digest, scrubbed: false };
}
