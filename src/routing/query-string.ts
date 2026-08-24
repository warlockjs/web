/**
 * The query string: BOTH directions, one grammar, one file.
 *
 * ── The rule this module exists to obey ──────────────────────────────────────
 *
 * `queryStringOf` is what `href(name, params, query)` appends, and therefore
 * what every `<Link>` puts in the document; `queryString.parse` is what reads it
 * back. They live together because a second, independently-written
 * query-string implementation would mean one thing writes URLs and a different
 * thing reads them. Query-string libraries genuinely disagree about arrays,
 * nested objects and space escaping, so the moment the two drift the round trip
 * loses data SILENTLY — the wrong value renders and no error is raised
 * anywhere. That is the two-route-matchers failure class (canon 9c8f878b) one
 * layer down.
 *
 * Escaping is not two rules that agree today. Both directions stand on
 * `URLSearchParams`: the encoder builds one and calls `.toString()`, the decoder
 * hands the string back to `new URLSearchParams(...)`. `+`-for-space and every
 * percent-encoding rule are therefore ONE rule and cannot drift.
 *
 * ── The grammar, and why it is not ours to choose ────────────────────────────
 *
 * Structure — arrays and nested objects — is the part `URLSearchParams` has no
 * opinion about, so it was read off the SERVER rather than invented. Warlock is
 * a backend framework and core already parses query strings for list endpoints
 * and filters; a client that emitted anything else would not have fixed this
 * module's bug, it would have moved it across the wire where it is harder to
 * see. Measured, with file:line, in
 * `reports/query-grammar-findings-2026-08-24.md`:
 *
 *   - `core/src/http/server.ts:14-36` configures Fastify with NO
 *     `querystringParser`, so find-my-way's `fast-querystring` default applies:
 *     flat keys, `+` is a space, a repeated key collapses to an array.
 *   - `core/src/http/request.ts:491` then runs `request.query` through
 *     `parseBody` — the SAME bracket-aware parser as the request body.
 *   - `core/src/http/request.ts:516-520` reads `key[]` as an array marker, and
 *     `:568-575` wraps a single `key[]=a` into the one-element array `["a"]`.
 *   - `core/src/http/request.ts:557-561` turns `key[sub]=v` into
 *     `{key: {sub: v}}`, one level deep.
 *
 * So: `tags[]=a&tags[]=b` for arrays, `filter[status]=active` for objects,
 * `filter[tags][]=a` for an array inside an object. Bare repeated keys
 * (`tags=a&tags=b`) would also reach core as an array, but only at cardinality
 * two or more — `tags=a` comes back as the scalar `"a"`, and a shape that
 * changes with the number of matches is a `TypeError` waiting for the day a
 * filter matches one item. `[]` is the form core wrote a branch for.
 *
 * ── What is REFUSED, and why refusing is the safe answer ─────────────────────
 *
 * Two levels of nesting is not a gap in core, it is measured data loss:
 * `a[b][c]=x` takes the `][` branch at `core/src/http/request.ts:528-551`,
 * computes `Number("b")` as `NaN`, and the value lands on a `NaN` index and
 * vanishes — core answers `{a: []}`. So the encoder throws
 * {@link UnserializableQueryValueError} rather than write it. `href()` already
 * throws on a missing route parameter rather than emit a link that renders
 * correctly and 404s; this is the same call.
 *
 * ── What the encoder still normalises, and what that costs ───────────────────
 *
 * Leaf values are serialised with `String(value)`, so every value arrives back
 * as a `string`: `href("p", {}, { page: 2 })` writes `?page=2`, and `2` and
 * `"2"` are the same URL. The round-trip law that can actually hold is
 * `parse(encode(query)) === query with String() applied to its leaves and
 * undefined dropped`, and that is what the spec asserts. Asserting anything
 * stronger would be asserting a decoder that guesses types, which is how
 * `?zip=01234` becomes the number `1234`.
 *
 * The decoder does NOT split values on `,`: that would turn the legitimate
 * string `"Doe, John"` into `["Doe", " John"]`, trading a visible limitation for
 * a silent corruption of ordinary data. Arrays are carried by `[]`, which is
 * unambiguous, so there is nothing left to guess at.
 *
 * ── Universal by requirement, not by accident ────────────────────────────────
 *
 * `web` renders on the server first, so every export here is safe to import and
 * to CALL with no DOM. `@mongez/react-router`'s equivalent reads
 * `window.location.search` unguarded (query-string.ts:22) and throws under SSR.
 * Here the browser-only readers return their empty answer instead — see
 * `queryString.all` for the hydration caveat that comes with that.
 *
 * ── Still NOT here: `toQueryString` and `update` ─────────────────────────────
 *
 * MRR exposes `toQueryString(params)` and `update(params)`, which SERIALISE.
 * The serialiser they need is no longer module-private — `queryStringOf` is
 * exported from here — so the old blocker is gone. What remains is that
 * `web/src/index.ts` does not re-export it yet, and the barrel is owned
 * elsewhere. That is a one-line follow-up, not a redesign.
 */

/** A decoded leaf. Always a `string` — see the header on `String(value)`. */
export type QueryStringLeaf = string;

/**
 * The inside of a `key[sub]` bag: one level deep, exactly as far as core parses.
 *
 * There is no deeper case to model. `key[sub][deeper]` is refused by the encoder
 * and carried verbatim as a literal key by the decoder, so a nested bag only
 * ever holds a leaf or an array of leaves.
 */
export type QueryStringNested = Record<string, QueryStringLeaf | QueryStringLeaf[]>;

/** A decoded value: a leaf, a `key[]` array, or a `key[sub]` bag. */
export type QueryStringValue = QueryStringLeaf | QueryStringLeaf[] | QueryStringNested;

/** A decoded query string. */
export type QueryStringObject = Record<string, QueryStringValue>;

/** What {@link queryStringOf} accepts. Values are validated, not trusted. */
export type QueryStringInput = Readonly<Record<string, unknown>>;

/**
 * Thrown when a query value has a shape the wire format cannot carry.
 *
 * Deliberately LOUD. The alternative is emitting something core silently
 * mangles — `a[b][c]=x` arrives as `{a: []}` — which is this defect all over
 * again, one layer further from where anyone would look for it.
 */
export class UnserializableQueryValueError extends Error {
  public constructor(
    public readonly queryKey: string,
    public readonly shape: string,
  ) {
    super(
      `Warlock cannot put ${shape} in a query string at "${queryKey}". The wire format is the ` +
        "one @warlock.js/core parses (core/src/http/request.ts:503-591): a value may be a " +
        "scalar, an array of scalars (`key[]=a&key[]=b`), or an object one level deep whose " +
        "values are scalars or arrays of scalars (`key[sub]=a`, `key[sub][]=a`). Anything " +
        "deeper is refused rather than written, because core reads `a[b][c]=x` back as " +
        "`{a: []}` — the value is destroyed on arrival with no error. Flatten the value, or " +
        "JSON.stringify it into a single scalar and parse it on the server.",
    );
    this.name = "UnserializableQueryValueError";
  }
}

/**
 * Is this a BAG of query keys, as opposed to a value with its own string form?
 *
 * A `Date`, a `URL` or anything else carrying its own `toString` is a scalar
 * here — `String(value)` is meaningful for it, and turning it into
 * `since[getTime]=...` would be absurd. A plain object, or a class instance that
 * would otherwise stringify to the useless `"[object Object]"`, is a bag and
 * gets enumerated.
 *
 * The `typeof` check matters for null-prototype objects: they have no
 * `toString` at all, and `String()` on one THROWS.
 */
function isKeyBag(value: object): boolean {
  const stringForm = (value as { toString?: unknown }).toString;

  return typeof stringForm !== "function" || stringForm === Object.prototype.toString;
}

/** Refuse anything that is not a leaf. Used everywhere a leaf is the only legal shape. */
function requireLeaf(key: string, value: unknown): void {
  if (Array.isArray(value)) {
    throw new UnserializableQueryValueError(key, "a nested array");
  }

  if (typeof value === "object" && value !== null && isKeyBag(value)) {
    throw new UnserializableQueryValueError(key, "a nested object");
  }
}

/**
 * Append `key[]=element` per element.
 *
 * An `undefined` element is skipped, matching the top-level rule. Because the
 * `[]` form carries no indices, skipping shortens the array rather than leaving
 * a hole — there is no hole to leave.
 *
 * An EMPTY array appends nothing, so the key is absent from the URL. The format
 * has no way to say "an array with no elements": `key[]=` means the one-element
 * array `[""]`, which is a different value. A visible limitation beats a guess.
 */
function appendArray(search: URLSearchParams, key: string, value: readonly unknown[]): void {
  const arrayKey = `${key}[]`;

  for (const element of value) {
    if (element === undefined) continue;

    requireLeaf(arrayKey, element);

    search.append(arrayKey, String(element));
  }
}

/** Append `key[sub]=value`, or `key[sub][]=value` when the member is an array. */
function appendBag(search: URLSearchParams, key: string, value: object): void {
  for (const [subKey, subValue] of Object.entries(value)) {
    if (subValue === undefined) continue;

    const nestedKey = `${key}[${subKey}]`;

    if (Array.isArray(subValue)) {
      appendArray(search, nestedKey, subValue);
      continue;
    }

    requireLeaf(nestedKey, subValue);

    search.append(nestedKey, String(subValue));
  }
}

/**
 * Serialise a query object to a search string, INCLUDING the leading `?`.
 *
 * Returns `""` — not `"?"` — when there is nothing to write, so the result can
 * always be concatenated onto a path. `href()` is the primary caller; the
 * grammar it emits is the one core parses, and the whole justification is in the
 * module header.
 *
 * @throws {UnserializableQueryValueError} when a value nests deeper than the
 * wire format can carry.
 */
export function queryStringOf(query: QueryStringInput | undefined): string {
  if (query === undefined) return "";

  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      appendArray(search, key, value);
      continue;
    }

    if (typeof value === "object" && value !== null && isKeyBag(value)) {
      appendBag(search, key, value);
      continue;
    }

    search.append(key, String(value));
  }

  const serialized = search.toString();

  return serialized === "" ? "" : `?${serialized}`;
}

/**
 * What to do when the same PLAIN key appears more than once, e.g. `?tag=a&tag=b`.
 *
 * - `"last"` — keep the final occurrence. Matches `URLSearchParams.get()`, the
 *   read side of the primitive the encoder writes with, and keeps every value a
 *   `string`.
 * - `"first"` — keep the earliest occurrence.
 * - `"array"` — collect every occurrence. Under this strategy a key that occurs
 *   ONCE is still an array of one, because a shape that changes with the number
 *   of values is a `TypeError` waiting for the day a filter matches a single
 *   item.
 *
 * It does NOT govern `key[]` or `key[sub]`; those are shapes the encoder writes
 * deliberately, and their meaning is fixed. See {@link QueryStringOptions}.
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
 * `repeatedKeys` is safe for one specific reason, and the reason survived the
 * move to bracket notation: `queryStringOf` iterates `Object.entries`, so it can
 * never emit a duplicate PLAIN key. It now does emit duplicate `key[]` pairs —
 * that is how an array is written — but those go down the array branch of the
 * decoder, which this flag does not touch. Were the flag to govern the bracket
 * forms as well, `repeatedKeys: "array"` would decode `filter[x]=1` as
 * `{filter: {x: ["1"]}}` and break the round trip BY CONFIGURATION.
 *
 * So the flag still decides only something the encoder has no opinion about: a
 * repeated plain key, which can only arrive from a URL this package did not
 * write — hand-typed, external links, `GET` forms.
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
 * The three key shapes the encoder writes. Everything else is a literal key.
 *
 * The character classes exclude brackets, so each pattern matches exactly one
 * shape: `tags[]` cannot satisfy `NESTED`, and `a[b][c]` satisfies none of them.
 */
const ARRAY_KEY = /^([^[\]]+)\[\]$/;
const NESTED_KEY = /^([^[\]]+)\[([^[\]]+)\]$/;
const NESTED_ARRAY_KEY = /^([^[\]]+)\[([^[\]]+)\]\[\]$/;

type ParsedKey =
  | { kind: "plain"; name: string }
  | { kind: "array"; name: string }
  | { kind: "nested"; name: string; subKey: string }
  | { kind: "nestedArray"; name: string; subKey: string };

/**
 * Classify a decoded key.
 *
 * A shape neither side produces — `a[b][c]`, `items[0][name]`, an unbalanced
 * `a[` — falls through to `"plain"` and is carried VERBATIM. Those can only come
 * from a URL warlock did not write, and guessing at them is exactly how a
 * decoder drifts from its writer. Carrying the key as text loses nothing.
 */
function parseKey(key: string): ParsedKey {
  const nestedArray = NESTED_ARRAY_KEY.exec(key);

  if (nestedArray) {
    return { kind: "nestedArray", name: nestedArray[1], subKey: nestedArray[2] };
  }

  const array = ARRAY_KEY.exec(key);

  if (array) return { kind: "array", name: array[1] };

  const nested = NESTED_KEY.exec(key);

  if (nested) return { kind: "nested", name: nested[1], subKey: nested[2] };

  return { kind: "plain", name: key };
}

/** A fresh bag with NO prototype. See {@link decode} for why that is not optional. */
function emptyBag<T extends object>(): T {
  return Object.create(null) as T;
}

function isBag(value: unknown): value is QueryStringNested {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The array living at `container[name]`, created if it is not there yet.
 *
 * A conflicting earlier shape is REPLACED rather than written into. `?a=1&a[]=2`
 * is not something the encoder can emit, so it is a foreign URL contradicting
 * itself; appending to a string would be a silent no-op, and last-shape-wins at
 * least matches how `repeatedKeys: "last"` resolves the scalar version.
 */
function arrayAt(container: Record<string, unknown>, name: string): string[] {
  const existing = container[name];

  if (Array.isArray(existing)) return existing;

  const created: string[] = [];

  container[name] = created;

  return created;
}

/** The bag living at `result[name]`, created if absent. Same last-shape-wins rule. */
function bagAt(result: QueryStringObject, name: string): QueryStringNested {
  const existing = result[name];

  if (isBag(existing)) return existing;

  const created = emptyBag<QueryStringNested>();

  result[name] = created;

  return created;
}

/**
 * The single decode path. Every reader below goes through here.
 *
 * Every container has a NULL PROTOTYPE — the result and each `key[sub]` bag.
 * Query keys are attacker-controlled, and assigning `?__proto__=x` onto a `{}`
 * literal hits the inherited setter, which DISCARDS the key: data loss with no
 * error. Bracket parsing makes this sharper than it was when this decoder was
 * flat, because `?filter[__proto__]=x` now reaches a nested container too —
 * which is why `bagAt` builds with `Object.create(null)` rather than `{}`.
 * MRR's parser walks `key.split("[")` onto plain objects and needs the blocklist
 * at query-string-parsers.ts:7 as a result; with no prototype there is no setter
 * to hit and the key is stored as the ordinary data it is.
 */
function decode(source: string): QueryStringObject {
  const pairs = searchPairsOf(source);
  const result = emptyBag<QueryStringObject>();

  if (pairs === "") return result;

  const { repeatedKeys } = currentOptions();

  for (const [key, value] of new URLSearchParams(pairs)) {
    const parsed = parseKey(key);

    if (parsed.kind === "array") {
      arrayAt(result, parsed.name).push(value);
      continue;
    }

    if (parsed.kind === "nestedArray") {
      arrayAt(bagAt(result, parsed.name), parsed.subKey).push(value);
      continue;
    }

    if (parsed.kind === "nested") {
      // Last wins. The encoder cannot repeat a `key[sub]` pair — `Object.entries`
      // yields each sub-key once — so this only arises from a foreign URL, and
      // `repeatedKeys` deliberately does not reach here (QueryStringOptions).
      bagAt(result, parsed.name)[parsed.subKey] = value;
      continue;
    }

    if (!(parsed.name in result)) {
      result[parsed.name] = repeatedKeys === "array" ? [value] : value;
      continue;
    }

    if (repeatedKeys === "first") continue;

    if (repeatedKeys === "last") {
      result[parsed.name] = value;
      continue;
    }

    arrayAt(result, parsed.name).push(value);
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
