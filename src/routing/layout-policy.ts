/**
 * Layout policy — the single, pure rule for turning a page's ENUMERATED
 * layout chain into a selection decision.
 *
 * Enumeration and selection are deliberately separate concerns. Discovery
 * ({@link "../build/discover-pages.ts"}'s `layoutChainFor`) walks a page's
 * directory ancestry and reports every `layout.tsx` it finds, outermost
 * first, honestly and unfiltered — it does not decide whether that chain is
 * usable. This module is the one place that decision is made: given a chain,
 * how many layouts does composition get to use, and which one(s)?
 *
 * THE RULE COUNTS RENDERING LAYOUTS, NOT FILES. A layout that contributes no
 * element to the document — one with no default export, carrying only
 * `prefix`, `middleware` or other named exports — is not a second wrapper and
 * never was. Counting files instead of wrappers made an authorization boundary
 * indistinguishable from a nested layout, and the resulting refusal told app
 * authors to delete the boundary to make the build pass. Nested RENDERING
 * layouts remain unsupported; everything else composes freely.
 *
 * DIRECTORY CONTRACT — applies to everything in `web/src/routing/`: nothing
 * here may import `node:fs`, `node:path`, `vite`, or `fastify`. This module
 * receives a canonical chain and trusts nothing about it beyond the input
 * contract asserted below — it asserts rather than trusts, but it never
 * repairs. It therefore never DECIDES what renders either: that answer needs
 * the filesystem, so the caller — which has it — classifies each entry and
 * passes the classification in. Discovery owns the fact; this module owns the
 * rule. The `layout` identifiers are opaque (paths, in practice) and this
 * module never inspects their shape; it only counts and selects.
 *
 * REJECTION IS DATA, NOT A THROW: a chain with two or more rendering layouts
 * does not make {@link selectPageLayout} raise — it returns the rejected
 * rendering layouts, in order. What a rejection MEANS to the user is
 * nonetheless fixed here: {@link NestedLayoutsNotSupportedError} is the single
 * error contract for it — one class, one message shape, built from the
 * rejection data plus caller-supplied page identity. Callers decide only WHEN
 * to raise it and supply that context; none of them wraps the rejection in a
 * category or wording of its own. A shared policy whose failure semantics fork
 * per caller is shared in the happy path and forked in the sad one — and the
 * sad path is the one users meet.
 */

/**
 * One layout in a chain, with the caller's answer to the only question this
 * module needs about it: does it render?
 *
 * `renders` is true when the layout's module has a default export — the thing
 * that puts an element in the document. Everything else it exports (`prefix`,
 * `middleware`, helpers) is invisible to this rule.
 */
export type LayoutChainEntry = {
  /** Opaque identifier for the layout — an app-root-relative POSIX path, in practice. */
  layout: string;
  /** Whether this layout contributes an element to the document. */
  renders: boolean;
};

/**
 * A chain as {@link selectPageLayout} accepts it: classified entries, or bare
 * identifiers for a caller that has not classified its chain yet.
 *
 * TRANSITIONAL: a bare string is read as a RENDERING layout, which is the
 * conservative reading (it can only make the rule stricter, never looser) and
 * reproduces this module's pre-classification behaviour exactly. It exists so
 * the boot-time manifest installer — which holds loaded modules rather than
 * source files — keeps working unchanged until it classifies too; remove the
 * string arm once every caller passes {@link LayoutChainEntry}s.
 */
export type LayoutChainInput = readonly (string | LayoutChainEntry)[];

/**
 * The policy's decision for one page's layout chain:
 *
 * - `"none"` — no layout on the chain renders; the page composes against no
 *   layout. A chain of three middleware-only layouts lands here exactly as an
 *   empty chain does, because neither has a wrapper in it.
 * - `"selected"` — exactly one layout renders; `layout` is that element, which,
 *   being the only rendering one, is simultaneously the outermost and the
 *   nearest rendering layout — there is no distinction to draw between the two
 *   when there is only one.
 * - `"rejected"` — more than one layout renders; `layouts` carries the
 *   RENDERING layouts only, outermost-first, in chain order, so a consumer can
 *   name every layout actually at fault without naming the guards between them.
 */
export type LayoutPolicyResult =
  | { type: "none" }
  | { type: "selected"; layout: string }
  | { type: "rejected"; layouts: readonly string[] };

/**
 * Raised when a `chain` passed to {@link selectPageLayout} contains an empty
 * layout identifier. An empty string is not a layout identifier a caller could
 * have meant; this module refuses it rather than silently treating it as
 * absent or as a real selection.
 */
export class EmptyLayoutChainEntryError extends Error {
  public constructor(public readonly chain: readonly string[]) {
    super(
      `layout-policy: chain [${chain.map((entry) => `"${entry}"`).join(", ")}] contains an empty ` +
        "string. Every element of a layout chain passed to selectPageLayout must be a non-empty " +
        "layout identifier — omit the entry entirely rather than passing an empty string for it.",
    );
    this.name = "EmptyLayoutChainEntryError";
  }
}

/**
 * The single error contract for a `rejected` selection — the one class and
 * one message every caller of {@link selectPageLayout} raises when it refuses
 * a page whose path holds more than one RENDERING layout. `pageFile` and
 * `layoutFiles` are the caller's context (its audience-appropriate identifiers
 * for the page and the rejected rendering layouts — app-root-relative POSIX
 * paths, in practice); the category and wording are this module's.
 *
 * The wording names the rendering layouts and ONLY the rendering layouts, and
 * it does not offer removal as a remedy. Its predecessor said "remove or
 * consolidate the extra layout", which, on a chain whose second element was a
 * `middleware`-only authorization boundary, instructed the reader to delete
 * their security guard to make the build pass.
 */
export class NestedLayoutsNotSupportedError extends Error {
  public constructor(
    public readonly pageFile: string,
    public readonly layoutFiles: readonly string[],
  ) {
    super(
      `"${pageFile}" has more than one layout on its path that renders: ` +
        `${layoutFiles.map((file) => `"${file}"`).join(", ")}. Pages currently support at most one ` +
        "RENDERING layout — a layout with a default export — and nesting more than one is not yet " +
        "supported. Layouts that render nothing, such as a `prefix`- or `middleware`-only layout, " +
        "do not count against this and may nest freely. To fix: consolidate the rendering layouts " +
        "named above into one — and do not remove a middleware-only layout to satisfy this, since " +
        "none of them is what this refuses.",
    );
    this.name = "NestedLayoutsNotSupportedError";
  }
}

/** The classified form of an entry, whichever way the caller spelled it. */
function toEntry(entry: string | LayoutChainEntry): LayoutChainEntry {
  return typeof entry === "string" ? { layout: entry, renders: true } : entry;
}

/**
 * Selects which layout, if any, a page RENDERS inside, given its layout chain
 * as enumerated outermost-first.
 *
 * Only entries with `renders: true` are counted: no rendering layout yields
 * `{ type: "none" }`; exactly one yields `{ type: "selected"; layout }`; more
 * than one yields `{ type: "rejected"; layouts }` carrying just those rendering
 * layouts — this function throws nothing for that case; see the module doc for
 * why rejection is data, not a throw.
 *
 * Throws {@link EmptyLayoutChainEntryError} when any entry's identifier is an
 * empty string — the one input-contract violation this module refuses rather
 * than passes through as a selection.
 */
export function selectPageLayout(chain: LayoutChainInput): LayoutPolicyResult {
  const entries = chain.map(toEntry);

  if (entries.some((entry) => entry.layout === "")) {
    throw new EmptyLayoutChainEntryError(entries.map((entry) => entry.layout));
  }

  const rendering = entries.filter((entry) => entry.renders).map((entry) => entry.layout);

  if (rendering.length === 0) {
    return { type: "none" };
  }

  if (rendering.length === 1) {
    return { type: "selected", layout: rendering[0] };
  }

  return { type: "rejected", layouts: rendering };
}
