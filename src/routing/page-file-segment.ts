/**
 * Page-file segment grammar — the single, pure predicate that decides
 * whether one filesystem segment of a page file (a directory name or the
 * `.page.tsx` basename) is inside the grammar `filesystem-route.ts` can
 * actually translate into a route. This is a SIBLING of
 * `page-route-grammar.ts`, not an extension of it: that module validates a
 * page's DECLARED colon-form `route.path` (`/users/:id`); this one validates
 * a FILESYSTEM segment as it appears on disk (`[id]`) before it is turned
 * into one.
 *
 * DIRECTORY CONTRACT — applies to everything in `web/src/routing/`: nothing
 * here may import `node:fs`, `node:path`, `vite`, or `fastify`. This module
 * receives a single path segment string and trusts nothing about it beyond
 * what it checks — it asserts rather than trusts, but it never repairs a
 * malformed segment into a valid one.
 *
 * ALLOWED — and ONLY these shapes; anything else is rejected by default:
 * a plain static segment containing no "[" and no "]" at all; a `(group)`
 * directory whose name contains no "[" and no "]"; and exactly `[name]`,
 * where the segment is nothing but a single bracket pair and `name` matches
 * `^[A-Za-z_][A-Za-z0-9_]*$` — i.e. precisely the shape `filesystem-route.ts`
 * can translate into a `:name` route param.
 *
 * REJECTED — each with a reason naming the offending segment and, where one
 * exists, the supported alternative: a `(group)` directory whose name
 * contains "[" or "]" anywhere (`(bad[id])`, `([x])`) — a group contributes
 * nothing to the URL path, so bracket syntax inside one can never produce a
 * dynamic segment, and the fix is to move the dynamic segment out of the
 * group; a catch-all group (`[...slug]`, `[...]`); two or more bracket
 * groups in one segment (`[id].[slug]`, `[a]-[b]`); a bracket group mixed
 * with other text (`pre[id]`); an empty parameter name (`[]`); a parameter
 * name that does not start with a letter or `_`, or contains a character
 * other than a letter, digit or `_` (`[1bad]`, `[a-b]`, `[a b]`); and
 * unbalanced or stray `[`/`]` characters.
 *
 * REJECTION IS DATA, NOT A THROW: {@link classifyPageFileSegment} is total
 * and never raises. What a rejection MEANS to the user is nonetheless fixed
 * here: {@link PageFileSegmentNotSupportedError} is the single error
 * contract every caller raises when it refuses a rejected segment — one
 * class, one message shape, built from the rejection reason plus
 * caller-supplied page identity. Callers decide only WHEN to raise it and
 * supply that context; none of them wraps the rejection in a category or
 * wording of its own.
 */

/**
 * The predicate's verdict for one filesystem segment:
 *
 * - `"allowed"` — the segment is one of the grammar's allowed shapes.
 * - `"rejected"` — the segment is outside the grammar; `reason` is a
 *   complete, user-readable sentence naming the offending segment and the
 *   supported alternative if one exists.
 */
export type PageFileSegmentVerdict = { type: "allowed" } | { type: "rejected"; reason: string };

const allowed: PageFileSegmentVerdict = { type: "allowed" };

function rejected(reason: string): PageFileSegmentVerdict {
  return { type: "rejected", reason };
}

/** A whole, unqualified parameter name — no leading digit, no punctuation. */
const parameterNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A single balanced, non-nested bracket group such as `[id]` or `[...slug]`. */
const bracketGroupPattern = /\[[^[\]]*]/g;

/** A `(group)` directory — the whole segment wrapped in one pair of parens. */
const groupSegmentPattern = /^\(([^/]+)\)$/;

/**
 * Decides whether one filesystem segment is inside the grammar
 * `filesystem-route.ts` can translate. Pure and total: every input yields a
 * verdict and nothing throws. `segment` must already be the isolated
 * segment (a single directory name, or the page basename with `.page.tsx`
 * already stripped) — no normalization is performed here.
 */
export function classifyPageFileSegment(segment: string): PageFileSegmentVerdict {
  const groupMatch = groupSegmentPattern.exec(segment);

  if (groupMatch) {
    const groupName = groupMatch[1];

    if (groupName.includes("[") || groupName.includes("]")) {
      return rejected(
        `Segment "${segment}" is a group, and a group contributes nothing to the URL path, so ` +
          `bracket syntax inside it can never produce a dynamic segment — move the dynamic ` +
          `segment out of the group, as in "(marketing)/[id]/page.page.tsx" rather than ` +
          `"(marketing[id])/page.page.tsx".`,
      );
    }

    return allowed;
  }

  if (!segment.includes("[") && !segment.includes("]")) {
    return allowed;
  }

  const groups = segment.match(bracketGroupPattern) ?? [];
  const remaining = groups.reduce((text, group) => text.replace(group, ""), segment);

  if (remaining.includes("[") || remaining.includes("]")) {
    return rejected(
      `Segment "${segment}" has unbalanced "[" or "]" brackets, which page routes do not ` +
        `support — balance the brackets, as in a whole-segment param like "[id]".`,
    );
  }

  if (groups.length > 1) {
    return rejected(
      `Segment "${segment}" contains more than one bracket group, and page routes require a ` +
        `dynamic segment to occupy its whole filesystem segment — split them into separate ` +
        `directory segments, as in "[id]/[slug]".`,
    );
  }

  const [group] = groups;

  if (remaining !== "") {
    return rejected(
      `Segment "${segment}" mixes a bracket group with other text, and page routes require a ` +
        `dynamic segment to occupy its whole filesystem segment — declare it as its own segment, ` +
        `as in "[id]".`,
    );
  }

  const name = group.slice(1, -1);

  if (name === "") {
    return rejected(
      `Segment "${segment}" has an empty parameter name — declare a name inside the brackets, ` +
        `as in "[id]".`,
    );
  }

  if (name.startsWith("...")) {
    return rejected(
      `Segment "${segment}" is a catch-all pattern, which page routes do not support — page ` +
        `routes support only a whole-segment param such as "[id]", not a catch-all.`,
    );
  }

  if (parameterNamePattern.test(name)) {
    return allowed;
  }

  return rejected(
    `Segment "${segment}" declares a parameter name page routes do not support — a parameter ` +
      `name must start with a letter or "_" and contain only letters, digits and "_", as in ` +
      `"[id]" or "[user_id]".`,
  );
}

/**
 * The single error contract for a rejected page-file segment — the one
 * class and one message every caller of {@link classifyPageFileSegment}
 * raises when it refuses a page whose filesystem segment was rejected.
 * `pageFile` is the caller's context (its audience-appropriate identifier
 * for the page — an app-root-relative POSIX path, in practice); `segment`
 * and `reason` come from the verdict; the category and wording are this
 * module's.
 */
export class PageFileSegmentNotSupportedError extends Error {
  public constructor(
    public readonly pageFile: string,
    public readonly segment: string,
    public readonly reason: string,
  ) {
    super(
      `"${pageFile}" contains the filesystem segment "${segment}", which is not supported: ` +
        `${reason} Page routes support a plain static segment or a whole-segment dynamic param ` +
        `such as "[id]".`,
    );
    this.name = "PageFileSegmentNotSupportedError";
  }
}
