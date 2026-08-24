/**
 * Page-route grammar — the single, pure predicate that decides whether a
 * page's declared `route.path` is inside the PAGE route grammar. Page routes
 * deliberately support a NARROWER grammar than API routes: every place that
 * validates a page path consults this one predicate, so build and boot cannot
 * quietly disagree about what a page is allowed to declare.
 *
 * DIRECTORY CONTRACT — applies to everything in `web/src/routing/`: nothing
 * here may import `node:fs`, `node:path`, `vite`, or `fastify`. This module
 * receives a canonical route path string and trusts nothing about it beyond
 * what it checks — it asserts rather than trusts, but it never repairs a
 * malformed path into a valid one.
 *
 * ALLOWED — and ONLY these shapes; anything else is rejected by default:
 * the root path `/`; static segments (`/users/settings`); whole-segment
 * `:param` segments where the param occupies its entire segment
 * (`/users/:id`); the exact root wildcard `*` (the one path allowed without
 * a leading slash — distinct from `/*`); and slash-led paths whose FINAL
 * segment is exactly `*` (`/*`, `/prefix/*`, `/a/b/*`).
 *
 * REJECTED — each with a reason naming the offending construct and, where
 * one exists, the supported alternative: regex-constrained params
 * (`/users/:id(\d+)`), optional params (`/users/:id?`), multiple params in
 * one segment (`/near/:lat-:lng`), params mixed with static text
 * (`/file/:name.png`, `/pre:id`), backslash-escaped colons
 * (`/path/\:literal`), a `*` that does not occupy a whole terminal segment
 * (`/a/prefix*`, or a wildcard before the final segment), paths missing
 * their leading slash, empty
 * segments from doubled slashes (`/a//b`), and trailing slashes (`/users/`).
 *
 * REJECTION IS DATA, NOT A THROW: {@link classifyPageRoutePath} is total and
 * never raises. What a rejection MEANS to the user is nonetheless fixed
 * here: {@link PageRoutePathNotSupportedError} is the single error contract
 * every caller raises when it refuses a rejected path — one class, one
 * message shape, built from the rejection reason plus caller-supplied page
 * identity. Callers decide only WHEN to raise it and supply that context;
 * none of them wraps the rejection in a category or wording of its own.
 */

/**
 * The predicate's verdict for one declared page route path:
 *
 * - `"allowed"` — the path is one of the grammar's allowed shapes.
 * - `"rejected"` — the path is outside the grammar; `reason` is a complete,
 *   user-readable sentence naming the offending construct (the segment, when
 *   one segment is at fault) and the supported alternative if one exists.
 */
export type PageRoutePathVerdict =
  | { type: "allowed" }
  | { type: "rejected"; reason: string };

const allowed: PageRoutePathVerdict = { type: "allowed" };

function rejected(reason: string): PageRoutePathVerdict {
  return { type: "rejected", reason };
}

/** Whole-segment `:param` — the entire segment is `:` followed by a plain name. */
const wholeSegmentParamPattern = /^:[A-Za-z0-9_]+$/;

/**
 * Classifies one segment of a slash-led path. `isFinal` matters because `*`
 * is allowed only as the whole final segment, and an empty segment at the
 * end means a trailing slash rather than a doubled one.
 */
function classifySegment(segment: string, path: string, isFinal: boolean): PageRoutePathVerdict {
  if (segment === "") {
    if (isFinal) {
      return rejected(
        `Path "${path}" ends with a trailing slash, which page routes do not support — ` +
          `declare "${path.slice(0, -1)}" without the trailing slash instead.`,
      );
    }

    return rejected(
      `Path "${path}" contains an empty segment from a doubled slash, which page routes do not ` +
        `support — remove the extra slash.`,
    );
  }

  if (segment === "*") {
    if (isFinal) {
      return allowed;
    }

    return rejected(
      `Path "${path}" uses "*" before its final segment, and page routes support "*" only as a ` +
        `terminal catch-all — move the "*" to the end of the path, as in "/a/b/*".`,
    );
  }

  if (segment.includes("*")) {
    if (isFinal) {
      return rejected(
        `Segment "${segment}" of "${path}" attaches "*" to other text, and page routes support ` +
          `"*" only as a whole final segment — declare it as its own segment, as in "/prefix/*".`,
      );
    }

    return rejected(
      `Segment "${segment}" of "${path}" uses "*" before the final segment, and page routes ` +
        `support "*" only as a whole terminal segment — move the "*" to the end of the path, as ` +
        `in "/a/b/*".`,
    );
  }

  if (segment.includes("\\:")) {
    return rejected(
      `Segment "${segment}" of "${path}" escapes a colon with a backslash, which page routes do ` +
        `not support — page routes treat ":" only as a whole-segment param marker, so a literal ` +
        `colon cannot be declared; rename the segment to avoid the colon.`,
    );
  }

  if (!segment.includes(":")) {
    return allowed;
  }

  if (wholeSegmentParamPattern.test(segment)) {
    return allowed;
  }

  if (segment.includes("(")) {
    return rejected(
      `Segment "${segment}" of "${path}" constrains its param with a regex, which page routes do ` +
        `not support — use a plain whole-segment param such as ":id" and validate the value in ` +
        `the page instead.`,
    );
  }

  if (segment.endsWith("?")) {
    return rejected(
      `Segment "${segment}" of "${path}" marks its param optional with "?", which page routes do ` +
        `not support — declare two pages instead, one with the param segment and one without it.`,
    );
  }

  if (segment.split(":").length - 1 > 1) {
    return rejected(
      `Segment "${segment}" of "${path}" declares more than one param, and page routes require a ` +
        `param to occupy its whole segment — split the params into separate segments, as in ` +
        `":lat/:lng".`,
    );
  }

  return rejected(
    `Segment "${segment}" of "${path}" mixes a ":" param with other text, and page routes ` +
      `require a param to occupy its whole segment — use a plain whole-segment param such as ` +
      `":id" instead.`,
  );
}

/**
 * Decides whether a declared page `route.path` is inside the page-route
 * grammar. Pure and total: every input yields a verdict and nothing throws.
 * `path` must already be canonical (no normalization is performed here — as
 * with the rest of this directory, this module asserts, it never repairs).
 */
export function classifyPageRoutePath(path: string): PageRoutePathVerdict {
  if (path === "*") {
    return allowed;
  }

  if (path === "") {
    return rejected(
      `The page route path is empty — declare "/" for the site root instead.`,
    );
  }

  if (!path.startsWith("/")) {
    return rejected(
      `Path "${path}" does not start with "/", and the only page route allowed without a leading ` +
        `slash is the exact root wildcard "*" — declare "/${path}" instead.`,
    );
  }

  if (path === "/") {
    return allowed;
  }

  const segments = path.slice(1).split("/");
  const lastIndex = segments.length - 1;

  for (const [index, segment] of segments.entries()) {
    const verdict = classifySegment(segment, path, index === lastIndex);

    if (verdict.type === "rejected") {
      return verdict;
    }
  }

  return allowed;
}

/**
 * The single error contract for a rejected page route path — the one class
 * and one message every caller of {@link classifyPageRoutePath} raises when
 * it refuses a page whose declared path was rejected. `pageFile` is the
 * caller's context (its audience-appropriate identifier for the page — an
 * app-root-relative POSIX path, in practice); `routePath` and `reason` come
 * from the verdict; the category and wording are this module's.
 */
export class PageRoutePathNotSupportedError extends Error {
  public constructor(
    public readonly pageFile: string,
    public readonly routePath: string,
    public readonly reason: string,
  ) {
    super(
      `"${pageFile}" declares the page route path "${routePath}", which is not supported: ` +
        `${reason} Page routes support a narrower grammar than API routes — a page path may be ` +
        `"/", static segments, whole-segment ":param" segments, the exact root wildcard "*", or ` +
        `a path whose final segment is exactly "*" (such as "/prefix/*").`,
    );
    this.name = "PageRoutePathNotSupportedError";
  }
}
