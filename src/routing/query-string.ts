/**
 * Reading the query string — the DECODE half of the one encoder this package
 * already has.
 *
 * ── The rule this module exists to obey ──────────────────────────────────────
 *
 * `web` already WRITES query strings: `queryStringOf` (route-table.ts:246) is
 * what `href(name, params, query)` appends, and therefore what every `<Link>`
 * puts in the document. This module is the READ direction of that same wire
 * format, and nothing else.
 *
 * A second, independently-written query-string implementation would mean one
 * thing writes URLs and a different thing reads them. Query-string libraries
 * genuinely disagree about arrays, nested objects and space escaping, so the
 * moment the two drift the round trip loses data SILENTLY — the wrong value
 * renders and no error is raised anywhere. That is the two-route-matchers
 * failure class (canon 9c8f878b) one layer down.
 *
 * So both directions stand on the SAME primitive: `URLSearchParams`. The
 * encoder builds one and calls `.toString()`; this module hands the string back
 * to `new URLSearchParams(...)` and reads it out. Escaping, `+`-for-space, and
 * every percent-encoding rule are therefore not two rules that agree today —
 * they are one rule, and cannot drift.
 *
 * ── What the encoder does to values, and what that costs ─────────────────────
 *
 * `queryStringOf` serialises with `String(value)` (route-table.ts:252). Two
 * consequences, both PROVEN in the co-located spec against the real `href()`:
 *
 *   - Every value arrives back as a `string`. `href("p", {}, { page: 2 })`
 *     writes `?page=2`, and `2` and `"2"` are the same URL. The round-trip law
 *     that can actually hold is therefore
 *     `parse(encode(query)) === query with String() applied and undefined dropped`,
 *     and that is what the spec asserts.
 *
 *   - Arrays and nested objects are destroyed BEFORE they reach the wire.
 *     `{ tags: ["a", "b"] }` becomes `?tags=a%2Cb`, byte-identical to
 *     `{ tags: "a,b" }`; `{ filter: { id: 1 } }` becomes
 *     `?filter=%5Bobject+Object%5D`. No decoder can undo either, and this one
 *     deliberately does not try: splitting values on `,` would turn the
 *     legitimate string `"Doe, John"` into an array. Guessing here would trade
 *     a visible limitation for a silent corruption. See the "encoder is lossy"
 *     block in the spec for the exact inputs and outputs.
 *
 * ── Universal by requirement, not by accident ────────────────────────────────
 *
 * `web` renders on the server first, so every export here is safe to import and
 * to CALL with no DOM. `@mongez/react-router`'s equivalent reads
 * `window.location.search` unguarded (query-string.ts:22) and throws under SSR.
 * Here the browser-only readers return their empty answer instead — see
 * `queryString.all` for the hydration caveat that comes with that.
 *
 * ── Deliberately NOT here: `toQueryString` and `update` ──────────────────────
 *
 * MRR exposes `toQueryString(params)` and `update(params)`, which SERIALISE.
 * Both are omitted, because the serialiser they need is `queryStringOf` and it
 * is module-private to route-table.ts. Writing a copy of it here is the exact
 * defect described at the top of this file, so the write half stays absent
 * until the one encoder can be shared. The unblocking change is in the worker
 * report; it is a one-line move, not a redesign.
 */

/** A decoded value. `string[]` only ever appears under `repeatedKeys: "array"`. */
export type QueryStringValue = string | string[];

/** A decoded query string. Always a flat bag of strings — see the header. */
export type QueryStringObject = Record<string, QueryStringValue>;

/**
 * What to do when the SAME key appears more than once, e.g. `?tag=a&tag=b`.
 *
 * - `"last"` — keep the final occurrence. Matches `URLSearchParams.get()`, the
 *   read side of the primitive the encoder writes with, and keeps every value a
 *   `string`.
 * - `"first"` — keep the earliest occurrence.
 * - `"array"` — collect every occurrence. Under this strategy a key that occurs
 *   ONCE is still an array of one, because a shape that changes with the number
 *   of values is a `TypeError` waiting for the day a filter matches a single
 *   item.
 */
export type RepeatedKeyStrategy = "last" | "first" | "array";

/**
 * The whole option surface.
 *
 * ── Why this is one flag and not MRR's pluggable parsers ─────────────────────
 *
 * MRR's `setQueryStringOptions` swaps `objectParser` and `stringParser`
 * (query-string.ts:10-15). Neither survives contact with a fixed, shared
 * encoder:
 *
 *   - A pluggable `objectParser` is a licence to install a READER that disagrees
 *     with the writer. It is precisely the silent round-trip break this module
 *     was written to prevent, offered as a supported API.
 *   - A pluggable `stringParser` would be worse: it cannot reach `href()`, which
 *     calls `queryStringOf` directly with no hook. Setting it would change what
 *     this module emits while every `<Link>` on the page kept emitting the old
 *     format — two writers, disagreeing, by configuration.
 *
 * `repeatedKeys` is safe for one specific reason: `queryStringOf` iterates
 * `Object.entries`, so it can NEVER emit a duplicate key. Repeated keys only
 * arrive from URLs this package did not write — hand-typed, external links,
 * `GET` forms. The flag decides something the encoder has no opinion about, so
 * no setting of it can put the two halves out of step.
 *
 * Set it at BOOT, not per request: this is process-global config, and a
 * request-scoped write would be read by whatever request happens to be
 * rendering (the defect catalogued at route-table.ts:10-25).
 */
export type QueryStringOptions = {
  readonly repeatedKeys?: RepeatedKeyStrategy;
};

type ResolvedQueryStringOptions = Required<QueryStringOptions>;

const DEFAULT_OPTIONS: ResolvedQueryStringOptions = {
  repeatedKeys: "last",
};

/**
 * Held on `globalThis`, not in a module binding, for the reason measured and
 * written up at route-table.ts:43-65: in dev the process runs two module graphs
 * over these files (tsx/Node and Vite's SSR runner), so a `let` written by boot
 * code is not the `let` a component reads. A split here would be quiet — the
 * second graph would silently fall back to the defaults and decode a repeated
 * key the other way.
 */
const OPTIONS_SLOT = Symbol.for("warlock.web.queryStringOptions");

type OptionsHost = typeof globalThis & {
  [OPTIONS_SLOT]?: ResolvedQueryStringOptions;
};

function currentOptions(): ResolvedQueryStringOptions {
  return (globalThis as OptionsHost)[OPTIONS_SLOT] ?? DEFAULT_OPTIONS;
}

/**
 * Merge query-string options over the current ones.
 *
 * Named for `@mongez/react-router`'s function so migrating call sites keep
 * compiling; the OPTIONS are deliberately narrower, and `QueryStringOptions`
 * explains exactly which ones were refused and why.
 */
export function setQueryStringOptions(options: QueryStringOptions): void {
  (globalThis as OptionsHost)[OPTIONS_SLOT] = { ...currentOptions(), ...options };
}

/**
 * Drop back to the defaults.
 *
 * Exists because the options are process-global: a test that set one would
 * otherwise leak it into every later test in the same worker, passing in file
 * order and failing under `--shuffle`. Same reasoning as `resetRouteTable`.
 */
export function resetQueryStringOptions(): void {
  delete (globalThis as OptionsHost)[OPTIONS_SLOT];
}

/**
 * The search string of the current document, or `""` when there is no document.
 *
 * The `typeof` guard is the SSR contract: no export in this module may touch a
 * DOM global without one.
 */
function browserSearch(): string {
  if (typeof window === "undefined") return "";

  return window.location?.search ?? "";
}

/**
 * Reduce anything search-shaped to the pairs themselves.
 *
 * Accepts `"?a=1"`, `"a=1"`, `"/path?a=1"` and a full URL, because
 * `location.href`, `location.search` and a hand-written literal all turn up at
 * this door and `new URLSearchParams("/path?a=1")` would answer with the key
 * `"/path?a"` — a wrong answer with no error. Cutting at the first `?` and the
 * first `#` is safe rather than heuristic: `queryStringOf` percent-encodes both
 * characters inside values (`%3F`, `%23`), so a literal one is always a
 * delimiter.
 */
function searchPairsOf(source: string): string {
  const withoutHash = source.split("#", 1)[0];
  const questionMark = withoutHash.indexOf("?");

  return questionMark === -1 ? withoutHash : withoutHash.slice(questionMark + 1);
}

/**
 * The single decode path. Every reader below goes through here.
 *
 * The result has a NULL PROTOTYPE. Query keys are attacker-controlled, and
 * assigning `?__proto__=x` onto a `{}` literal hits the inherited setter, which
 * DISCARDS the key — data loss with no error. (This decoder is flat, so the
 * bracket-nesting form that actually pollutes is not reachable here; MRR's
 * parser walks `key.split("[")` and needs the blocklist at
 * query-string-parsers.ts:7 because of it.) With no prototype there is no
 * setter to hit: the key is stored as ordinary data, which is what it is.
 */
function decode(source: string): QueryStringObject {
  const pairs = searchPairsOf(source);
  const result = Object.create(null) as QueryStringObject;

  if (pairs === "") return result;

  const { repeatedKeys } = currentOptions();

  for (const [key, value] of new URLSearchParams(pairs)) {
    if (!(key in result)) {
      result[key] = repeatedKeys === "array" ? [value] : value;
      continue;
    }

    if (repeatedKeys === "first") continue;

    if (repeatedKeys === "last") {
      result[key] = value;
      continue;
    }

    (result[key] as string[]).push(value);
  }

  return result;
}

/**
 * Reading the current query string, and any query string.
 *
 * Named for `@mongez/react-router`'s object so the familiar calls keep working;
 * the implementation is not ported — see the module header for what changed and
 * why.
 */
export const queryString = {
  /**
   * The current document's query string, decoded.
   *
   * On the server this is `{}`, because the browser location is the only source
   * this module has and a per-request one would be module state two concurrent
   * requests could race over (route-table.ts:10-25).
   *
   * That makes it a HYDRATION HAZARD in a component: the server renders `{}`
   * and the browser renders the real values, so the two trees differ. In a
   * component, take the query from the page's own props and hand it to
   * {@link queryString.parse}, which is universal. `all()` is for browser-only
   * code — an event handler, an effect, a client-side helper.
   */
  all(): QueryStringObject {
    return decode(browserSearch());
  },

  /**
   * Decode a query string that was handed to you.
   *
   * Universal: it reads no globals, so this is the entry point that is safe on
   * the server. Accepts a bare pair list, a leading `?`, a path, or a full URL.
   */
  parse(search: string): QueryStringObject {
    return decode(search);
  },

  /**
   * One key from the current query string.
   *
   * PRESENCE, not truthiness. MRR returns `all[key] || defaultValue`
   * (query-string.ts:43), which hands back the default for `?a=` — so a
   * deliberately-cleared filter reads as though it was never set, and the page
   * shows the default instead of the empty state. Here `?a=` returns `""`, and
   * only an absent key returns the default.
   *
   * @param defaultValue returned only when the key is absent. Defaults to
   * `null`, as MRR's does.
   */
  get<T = null>(key: string, defaultValue: T = null as T): QueryStringValue | T {
    const all = decode(browserSearch());

    return key in all ? all[key] : defaultValue;
  },

  /**
   * The current query string verbatim, without the leading `?`.
   *
   * `""` on the server, and `""` when there is no query — the same two cases
   * `queryStringOf` collapses when it writes.
   */
  toString(): string {
    return searchPairsOf(browserSearch());
  },
};
