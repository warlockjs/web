/**
 * Pure conditional-request metadata for an already generated sitemap file.
 *
 * The route owns reading headers and writing a response. This helper owns only
 * RFC HTTP validator precedence, so generation, storage, and cache drivers do
 * not enter the request path.
 */
export type SitemapHttpValidatorInput = {
  /** SHA-256 of the exact bytes that will be served. */
  readonly sha256: string;
  /** Time that those bytes became the current committed generation. */
  readonly generatedAt: Date | number | string;
  readonly ifNoneMatch?: string;
  readonly ifModifiedSince?: string;
  /** Conditional semantics apply to GET and HEAD; defaults to GET. */
  readonly method?: "GET" | "HEAD" | string;
  /** Browser-cache policy for the generated immutable-until-regenerated file. */
  readonly cacheControl?: string;
};

export type SitemapHttpValidators = {
  readonly etag: string;
  readonly lastModified: string;
  readonly cacheControl: string;
  /** Whether a GET or HEAD may return 304 with these response headers. */
  readonly notModified: boolean;
};

export const DEFAULT_SITEMAP_CACHE_CONTROL = "public, max-age=300";

function toSecond(date: Date | number | string): number {
  const milliseconds = date instanceof Date ? date.getTime() : new Date(date).getTime();

  if (!Number.isFinite(milliseconds)) {
    throw new TypeError("Sitemap generation date must be a valid date.");
  }

  return Math.floor(milliseconds / 1_000) * 1_000;
}

/** Split an entity-tag list without treating a comma inside a quoted tag as a separator. */
function entityTagList(value: string): string[] {
  const tags: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index++) {
    const character = value[index];

    if (quoted && character === "\\" && !escaped) {
      escaped = true;
      continue;
    }

    if (character === '"' && !escaped) quoted = !quoted;
    escaped = false;

    if (character === "," && !quoted) {
      tags.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }

  tags.push(value.slice(start).trim());

  return tags.filter(Boolean);
}

/** Weak comparison is required by If-None-Match for GET and HEAD. */
function weaklyMatches(candidate: string, etag: string): boolean {
  const normalized = candidate.replace(/^W\//i, "").trim();

  return normalized === etag;
}

function matchesIfNoneMatch(value: string, etag: string): boolean {
  return entityTagList(value).some(
    (candidate) => candidate === "*" || weaklyMatches(candidate, etag),
  );
}

/**
 * Builds strong validators for generated sitemap bytes and evaluates optional
 * conditional request headers. If-None-Match is deliberately authoritative:
 * when present, If-Modified-Since is never consulted.
 */
export function resolveSitemapHttpValidators(
  input: SitemapHttpValidatorInput,
): SitemapHttpValidators {
  const generatedAt = toSecond(input.generatedAt);
  const etag = `"${input.sha256}"`;
  const safeMethod =
    input.method === undefined || input.method === "GET" || input.method === "HEAD";
  let notModified = false;

  if (safeMethod && input.ifNoneMatch !== undefined) {
    notModified = matchesIfNoneMatch(input.ifNoneMatch, etag);
  } else if (safeMethod && input.ifModifiedSince !== undefined) {
    const modifiedSince = new Date(input.ifModifiedSince).getTime();

    if (Number.isFinite(modifiedSince)) {
      notModified = generatedAt <= Math.floor(modifiedSince / 1_000) * 1_000;
    }
  }

  return {
    etag,
    lastModified: new Date(generatedAt).toUTCString(),
    cacheControl: input.cacheControl ?? DEFAULT_SITEMAP_CACHE_CONTROL,
    notModified,
  };
}
