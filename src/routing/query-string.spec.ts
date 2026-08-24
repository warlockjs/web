import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  queryString,
  resetQueryStringOptions,
  setQueryStringOptions,
  UnserializableQueryValueError,
  type QueryStringObject,
} from "./query-string";
import { href, publishRouteTable, resetRouteTable, type RouteQuery } from "./route-table";

/**
 * Encode EXACTLY the way a `<Link>` does — through the real `href()`, not
 * through a copy of the encoder.
 *
 * This is the point of the whole file. A round trip against a local
 * re-implementation would prove that this module agrees with itself; only the
 * production writer can prove that what `<Link>` puts in the document is what
 * `queryString.parse` reads back. `queryStringOf` is exported now, but going
 * through `href` keeps these assertions pinned to the URL a visitor actually
 * clicks rather than to the helper underneath it.
 */
function encodeAsLinkWould(query: RouteQuery): string {
  const url = href("probe", undefined, query);
  const questionMark = url.indexOf("?");

  return questionMark === -1 ? "" : url.slice(questionMark);
}

/** Assert `parse(encode(query))` — the round trip — equals `expected`. */
function expectRoundTrip(query: RouteQuery, expected: QueryStringObject): void {
  expect(queryString.parse(encodeAsLinkWould(query))).toEqual(expected);
}

beforeEach(() => {
  publishRouteTable([{ name: "probe", path: "/probe" }], "query-string.spec");
});

afterEach(() => {
  resetRouteTable();
  resetQueryStringOptions();
  vi.unstubAllGlobals();
});

describe("round trip: href() writes it, queryString.parse() reads it back", () => {
  it("returns flat string values unchanged", () => {
    expectRoundTrip({ status: "active", sort: "name" }, { status: "active", sort: "name" });
  });

  it("survives every character the two halves could disagree about", () => {
    // The load-bearing case for "one primitive, two directions". A space is
    // written as `+` (measured: `?q=a+b`), and `+` is written as `%2B`. A
    // decoder built on `decodeURIComponent` — which is what
    // @mongez/react-router uses, query-string-parsers.ts:23 — reads `a+b` back
    // as the literal "a+b" and silently swaps the two inputs below. Only
    // URLSearchParams on both ends keeps them distinct.
    expectRoundTrip({ q: "a b" }, { q: "a b" });
    expectRoundTrip({ q: "a+b" }, { q: "a+b" });
    expect(encodeAsLinkWould({ q: "a b" })).toBe("?q=a+b");
    expect(encodeAsLinkWould({ q: "a+b" })).toBe("?q=a%2Bb");

    // Delimiters that would end the query, split a pair, or start a fragment if
    // either side got the escaping wrong.
    expectRoundTrip({ q: "a&b=c" }, { q: "a&b=c" });
    expectRoundTrip({ q: "#tag" }, { q: "#tag" });
    expectRoundTrip({ q: "?x" }, { q: "?x" });
    expectRoundTrip({ q: "a/b" }, { q: "a/b" });
    expectRoundTrip({ q: "café" }, { q: "café" });
  });

  it("normalises non-string scalars to strings, because the encoder does", () => {
    // route-table.ts:252 serialises with `String(value)`, so `2` and `"2"` are
    // the same five bytes on the wire. The honest round-trip law is
    // `parse(encode(q)) === q with String() applied`, and asserting anything
    // stronger would be asserting a decoder that guesses types — which is how
    // `?zip=01234` becomes the number 1234.
    expectRoundTrip({ page: 2, ok: true, n: null }, { page: "2", ok: "true", n: "null" });
    expect(encodeAsLinkWould({ page: 2 })).toBe("?page=2");
  });

  it("drops an undefined value entirely, and it comes back absent", () => {
    expect(encodeAsLinkWould({ a: undefined })).toBe("");
    expectRoundTrip({ a: "1", b: undefined, c: "" }, { a: "1", c: "" });
    expect("b" in queryString.parse(encodeAsLinkWould({ a: "1", b: undefined }))).toBe(false);
  });
});

describe("arrays and nested objects: the bracket grammar the SERVER parses", () => {
  // These shapes used to be destroyed at WRITE time by `String(value)`:
  // `{tags:["a","b"]}` became `?tags=a%2Cb` (byte-identical to the plain string
  // "a,b") and `{filter:{...}}` became `?filter=%5Bobject+Object%5D`. The
  // encoder now emits the grammar `@warlock.js/core` already reads — measured,
  // not invented, in reports/query-grammar-findings-2026-08-24.md:
  //
  //   core/src/http/request.ts:491      request.query goes through parseBody
  //   core/src/http/request.ts:516-520  `key[]` marks an array
  //   core/src/http/request.ts:557-561  `key[sub]` becomes {key: {sub}}
  //
  // so what `<Link>` writes and what a controller reads are one format.

  it("writes an array as repeated `key[]` pairs, at every cardinality", () => {
    expect(encodeAsLinkWould({ tags: ["a", "b"] })).toBe("?tags%5B%5D=a&tags%5B%5D=b");
    expectRoundTrip({ tags: ["a", "b"] }, { tags: ["a", "b"] });

    // The case the old encoder could not express at all. `?tags=a` would be read
    // back by core as the SCALAR "a" (fast-querystring only makes an array when
    // it sees a duplicate); `?tags[]=a` is wrapped into a one-element array by
    // request.ts:568-575. A shape that changes with the number of matches is a
    // TypeError waiting for the day a filter matches one item.
    expect(encodeAsLinkWould({ tags: ["a"] })).toBe("?tags%5B%5D=a");
    expectRoundTrip({ tags: ["a"] }, { tags: ["a"] });

    // And the array is now DISTINGUISHABLE from the comma string it used to be
    // byte-identical to — the whole point of the change.
    expect(encodeAsLinkWould({ tags: "a,b" })).toBe("?tags=a%2Cb");
    expectRoundTrip({ tags: "a,b" }, { tags: "a,b" });
  });

  it("does not split values on \",\", because commas are legitimate text", () => {
    // The guard on the tempting \"fix\" for the case above. A decoder that split
    // on \",\" to recover arrays would turn this name into ["Doe", " John"] —
    // trading a visible limitation for a silent corruption of ordinary data.
    expectRoundTrip({ name: "Doe, John" }, { name: "Doe, John" });
    expect(queryString.parse("?name=Doe%2C+John")).toEqual({ name: "Doe, John" });
  });

  it("writes a nested object as `key[sub]`, and reads it back as an object", () => {
    expect(encodeAsLinkWould({ filter: { status: "active" } })).toBe(
      "?filter%5Bstatus%5D=active",
    );
    expectRoundTrip({ filter: { status: "active" } }, { filter: { status: "active" } });

    // Several keys, one object, order preserved.
    expect(encodeAsLinkWould({ filter: { status: "active", min: 5 } })).toBe(
      "?filter%5Bstatus%5D=active&filter%5Bmin%5D=5",
    );
    expectRoundTrip({ filter: { status: "active", min: 5 } }, { filter: { status: "active", min: "5" } });
  });

  it("writes an array INSIDE an object as `key[sub][]`", () => {
    expect(encodeAsLinkWould({ filter: { tags: ["a", "b"] } })).toBe(
      "?filter%5Btags%5D%5B%5D=a&filter%5Btags%5D%5B%5D=b",
    );
    expectRoundTrip({ filter: { tags: ["a", "b"] } }, { filter: { tags: ["a", "b"] } });

    // Mixed scalar and array siblings.
    expectRoundTrip(
      { filter: { status: "active", tags: ["a", "b"] } },
      { filter: { status: "active", tags: ["a", "b"] } },
    );
  });

  it("drops an undefined member, at the top level and inside a container", () => {
    expect(encodeAsLinkWould({ filter: { status: "active", min: undefined } })).toBe(
      "?filter%5Bstatus%5D=active",
    );
    expect(encodeAsLinkWould({ tags: ["a", undefined, "b"] })).toBe(
      "?tags%5B%5D=a&tags%5B%5D=b",
    );
  });

  it("omits an empty array and an empty object, because the format cannot express them", () => {
    // A visible, documented limitation rather than a guess. `?tags[]=` would
    // mean the one-element array [""], which is a different value.
    expect(encodeAsLinkWould({ tags: [] })).toBe("");
    expect(encodeAsLinkWould({ filter: {} })).toBe("");
    expect(encodeAsLinkWould({ tags: [], page: 2 })).toBe("?page=2");
  });

  it("passes a key that already contains brackets through unchanged", () => {
    // The pre-existing manual workaround: before the encoder understood nesting,
    // `{"filter[status]": "active"}` was the only way to reach core's nested
    // parser. It still produces exactly the same bytes, and now decodes to the
    // same object the structured form does.
    expect(encodeAsLinkWould({ "filter[status]": "active" })).toBe("?filter%5Bstatus%5D=active");
    expect(queryString.parse(encodeAsLinkWould({ "filter[status]": "active" }))).toEqual({
      filter: { status: "active" },
    });
  });
});

describe("shapes the wire format cannot carry are REFUSED, not mangled", () => {
  // `a[b][c]=x` is not a gap in core — it is measured DATA LOSS: parseBody takes
  // the `][` branch (request.ts:528-551), computes `Number("b")` as NaN, and the
  // value lands on a NaN index that never survives. Emitting it would move this
  // card's bug across the wire, where it is harder to see. `href()` already
  // throws on a missing route parameter for the same reason.

  it("throws on an object nested two levels deep", () => {
    expect(() => encodeAsLinkWould({ filter: { range: { min: 1 } } })).toThrow(
      UnserializableQueryValueError,
    );
    expect(() => encodeAsLinkWould({ filter: { range: { min: 1 } } })).toThrow(
      /filter\[range\]/,
    );
  });

  it("throws on an array of objects rather than emitting a grammar it cannot read back", () => {
    expect(() => encodeAsLinkWould({ items: [{ name: "x" }] })).toThrow(
      UnserializableQueryValueError,
    );
  });

  it("throws on an array of arrays", () => {
    expect(() => encodeAsLinkWould({ grid: [["a"], ["b"]] })).toThrow(
      UnserializableQueryValueError,
    );
  });

  it("names the offending key and the shape in the message", () => {
    let message = "";

    try {
      encodeAsLinkWould({ filter: { range: { min: 1 } } });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("filter[range]");
    expect(message).toContain("object");
  });

  it("still serialises a value that has its own string form, like a Date", () => {
    const date = new Date("2026-08-24T00:00:00.000Z");

    // A Date is an object, but it is NOT a bag of query keys — it has a
    // meaningful string form, so it is a leaf here rather than a refusal, and
    // certainly not `since[getTime]=...`. Asserted through the round trip
    // because the exact bytes of `String(date)` are timezone-dependent.
    expect(() => encodeAsLinkWould({ since: date })).not.toThrow();
    expectRoundTrip({ since: date }, { since: String(date) });
    expect(encodeAsLinkWould({ since: date })).not.toContain("object+Object");
  });
});

describe("the decoder reads back only the grammar the encoder writes", () => {
  it("treats a key shape neither side can produce as a literal key", () => {
    // `a[b][c]` is refused by the encoder, so it can only arrive from a URL
    // warlock did not write. Guessing at it is how a decoder drifts from its
    // writer; carrying it verbatim loses nothing and surprises nobody.
    expect(queryString.parse("?a%5Bb%5D%5Bc%5D=x")).toEqual({ "a[b][c]": "x" });
    expect(queryString.parse("?items%5B0%5D%5Bname%5D=x")).toEqual({ "items[0][name]": "x" });
    expect(queryString.parse("?a%5B=1")).toEqual({ "a[": "1" });
  });

  it("keeps `key[]` an array even when it occurs once", () => {
    expect(queryString.parse("?tags%5B%5D=a")).toEqual({ tags: ["a"] });
  });

  it("gives a nested bag a null prototype too", () => {
    const parsed = queryString.parse("?filter%5B__proto__%5D=polluted");

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(parsed["filter"] as object)).toBeNull();
    expect((parsed["filter"] as Record<string, unknown>)["__proto__"]).toBe("polluted");
  });

  it("lets the last shape win when a foreign URL contradicts itself", () => {
    // `?a=1&a[b]=2` is not something the encoder can emit — `Object.entries`
    // yields each key once. Rather than dropping the second pair onto a string
    // (a silent no-op), the container is rebuilt.
    expect(queryString.parse("?a=1&a%5Bb%5D=2")).toEqual({ a: { b: "2" } });
    expect(queryString.parse("?a%5Bb%5D=2&a%5B%5D=1")).toEqual({ a: ["1"] });
  });
});

describe("empty values: `?a=`, `?a`, and an absent `a`", () => {
  it("round trips an empty string as an empty string", () => {
    expect(encodeAsLinkWould({ a: "" })).toBe("?a=");
    expectRoundTrip({ a: "" }, { a: "" });
  });

  it("reads a valueless `?a` as an empty string too — the two are the same URL", () => {
    // The encoder never writes the bare form, but a hand-typed or external URL
    // can. URLSearchParams collapses them, so this module does too; documenting
    // it beats inventing a third state the writer cannot express.
    expect(queryString.parse("?a")).toEqual({ a: "" });
    expect(queryString.parse("?a=")).toEqual({ a: "" });
  });

  it("distinguishes an EMPTY value from an ABSENT key, which MRR's `get` does not", () => {
    vi.stubGlobal("window", { location: { search: "?a=" } });

    // MRR: `all[key] || defaultValue` (query-string.ts:43) — "" is falsy, so a
    // deliberately-cleared filter reads as never-set and the page renders the
    // default instead of the empty state. Presence, not truthiness.
    expect(queryString.get("a", "fallback")).toBe("");
    expect(queryString.get("missing", "fallback")).toBe("fallback");
    expect(queryString.get("missing")).toBeNull();
  });
});

describe("universal: importable and callable with no DOM", () => {
  // The suite runs under `environment: "node"` (vitest.config.ts:50), so
  // `window` is genuinely undefined here — this is the real SSR shape, not a
  // simulation. MRR's `all()` reads `window.location.search` unguarded
  // (query-string.ts:22) and throws exactly here.

  it("does not throw from any reader", () => {
    expect(typeof window).toBe("undefined");
    expect(() => queryString.all()).not.toThrow();
    expect(() => queryString.get("a")).not.toThrow();
    expect(() => queryString.toString()).not.toThrow();
    expect(() => queryString.parse("?a=1")).not.toThrow();
  });

  it("answers empty for the browser-backed readers, and works fully for parse", () => {
    expect(queryString.all()).toEqual({});
    expect(queryString.toString()).toBe("");
    expect(queryString.get("a", "fallback")).toBe("fallback");

    // `parse` takes its input from the caller, so it is fully functional on the
    // server — it is the entry point a universal component should use.
    expect(queryString.parse("?a=1")).toEqual({ a: "1" });
  });
});

describe("browser readers", () => {
  it("reads the live location for all(), get() and toString()", () => {
    vi.stubGlobal("window", { location: { search: "?status=active&page=2" } });

    expect(queryString.all()).toEqual({ status: "active", page: "2" });
    expect(queryString.get("status")).toBe("active");
    expect(queryString.toString()).toBe("status=active&page=2");
  });

  it("survives a window with no search at all", () => {
    vi.stubGlobal("window", { location: { search: "" } });

    expect(queryString.all()).toEqual({});
    expect(queryString.toString()).toBe("");
  });
});

describe("parse input shapes", () => {
  it("accepts a leading `?`, a bare pair list, and an empty string", () => {
    expect(queryString.parse("?a=1")).toEqual({ a: "1" });
    expect(queryString.parse("a=1")).toEqual({ a: "1" });
    expect(queryString.parse("")).toEqual({});
    expect(queryString.parse("?")).toEqual({});
  });

  it("takes the query out of a path or a full URL instead of answering wrongly", () => {
    // `new URLSearchParams("/probe?a=1")` yields the key "/probe?a" — a wrong
    // answer with no error, which is the failure mode this module exists to
    // avoid. Cutting at the first `?` is safe, not heuristic: the encoder
    // percent-encodes `?` inside values (asserted above as `?q=%3Fx`).
    expect(queryString.parse("/probe?a=1")).toEqual({ a: "1" });
    expect(queryString.parse("https://example.com/probe?a=1")).toEqual({ a: "1" });
  });

  it("drops a fragment rather than folding it into the last value", () => {
    expect(queryString.parse("?a=1#section")).toEqual({ a: "1" });
    expect(queryString.parse("/probe?a=1#section")).toEqual({ a: "1" });
  });
});

describe("setQueryStringOptions: repeated keys, the one thing the encoder has no opinion on", () => {
  it("never sees a repeated PLAIN key from this package's own encoder", () => {
    // Why the option is still safe now that the encoder can repeat `tag[]`:
    // `queryStringOf` iterates `Object.entries`, so a plain key appears at most
    // once. `?tag=a&tag=b` can only come from a URL warlock did not write, which
    // means no setting of this flag can put the decoder out of step with the
    // encoder.
    expect(encodeAsLinkWould({ tag: "a", other: "b" })).toBe("?tag=a&other=b");
  });

  it("does not touch the bracket forms, which the encoder DOES have an opinion on", () => {
    // The strategy governs only the shape the encoder cannot emit. If it also
    // governed `tag[]` and `filter[x]`, then `repeatedKeys: "array"` would turn
    // `{filter:{x:"1"}}` into `{filter:{x:["1"]}}` and break the round trip by
    // configuration — the exact class of drift this module exists to prevent.
    for (const strategy of ["last", "first", "array"] as const) {
      setQueryStringOptions({ repeatedKeys: strategy });

      expect(queryString.parse(encodeAsLinkWould({ tags: ["a", "b"] }))).toEqual({
        tags: ["a", "b"],
      });
      expect(queryString.parse(encodeAsLinkWould({ filter: { x: "1" } }))).toEqual({
        filter: { x: "1" },
      });
    }
  });

  it('defaults to "last", matching URLSearchParams.get()', () => {
    expect(queryString.parse("?tag=a&tag=b")).toEqual({ tag: "b" });
  });

  it('keeps the earliest occurrence under "first"', () => {
    setQueryStringOptions({ repeatedKeys: "first" });

    expect(queryString.parse("?tag=a&tag=b")).toEqual({ tag: "a" });
  });

  it('collects every occurrence under "array" — including a single one', () => {
    setQueryStringOptions({ repeatedKeys: "array" });

    expect(queryString.parse("?tag=a&tag=b&tag=c")).toEqual({ tag: ["a", "b", "c"] });

    // A shape that changed with the number of values would be a TypeError
    // waiting for the day a filter matches one item.
    expect(queryString.parse("?tag=a")).toEqual({ tag: ["a"] });
  });

  it("merges over the current options and resets cleanly", () => {
    setQueryStringOptions({ repeatedKeys: "array" });
    setQueryStringOptions({});

    expect(queryString.parse("?tag=a&tag=b")).toEqual({ tag: ["a", "b"] });

    resetQueryStringOptions();

    expect(queryString.parse("?tag=a&tag=b")).toEqual({ tag: "b" });
  });
});

describe("untrusted keys", () => {
  it("carries `__proto__` as ordinary data without polluting anything", () => {
    const parsed: QueryStringObject = queryString.parse("?__proto__=polluted&a=1");

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(parsed)).toBeNull();

    // Kept, not dropped: MRR skips these keys outright
    // (query-string-parsers.ts:7,28-30), which loses data a page may legitimately
    // want to read. With no prototype there is nothing to protect.
    expect(parsed["__proto__"]).toBe("polluted");
    expect(parsed["a"]).toBe("1");
  });
});
