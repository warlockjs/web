import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  queryString,
  resetQueryStringOptions,
  setQueryStringOptions,
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
 * `queryString.parse` reads back. `queryStringOf` (route-table.ts:246) is
 * module-private, and `href` is its only public door.
 */
function encodeAsLinkWould(query: RouteQuery): string {
  const url = href("probe", undefined, query);
  const questionMark = url.indexOf("?");

  return questionMark === -1 ? "" : url.slice(questionMark);
}

/** Assert `parse(encode(query))` — the round trip — equals `expected`. */
function expectRoundTrip(query: RouteQuery, expected: Record<string, string>): void {
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

describe("the encoder is lossy before the wire — arrays and nested objects", () => {
  // REAL FINDING, not a gap in this module. `String(value)` (route-table.ts:252)
  // destroys these shapes at WRITE time, so the information is gone before any
  // decoder sees the URL. These tests pin the loss rather than paper over it:
  // if `queryStringOf` ever learns bracket or repeated-key array syntax, they go
  // red and the decoder gets updated in the same change.

  it("flattens an array to a comma-joined string, unrecoverably", () => {
    // `String(["a","b"])` is "a,b", so the array and the plain string produce
    // BYTE-IDENTICAL urls. That is the proof that no decoder can recover the
    // array: there is nothing left in the URL to tell them apart.
    expect(encodeAsLinkWould({ tags: ["a", "b"] })).toBe("?tags=a%2Cb");
    expect(encodeAsLinkWould({ tags: "a,b" })).toBe("?tags=a%2Cb");

    // So the round trip returns a string, and this module refuses to guess.
    expectRoundTrip({ tags: ["a", "b"] }, { tags: "a,b" });

    // A one-element array is likewise indistinguishable from the scalar.
    expect(encodeAsLinkWould({ tags: ["a"] })).toBe("?tags=a");
  });

  it("does not split values on \",\", because commas are legitimate text", () => {
    // The guard on the tempting \"fix\" for the case above. A decoder that split
    // on \",\" to recover arrays would turn this name into ["Doe", " John"] —
    // trading a visible limitation for a silent corruption of ordinary data.
    expectRoundTrip({ name: "Doe, John" }, { name: "Doe, John" });
    expect(queryString.parse("?name=Doe%2C+John")).toEqual({ name: "Doe, John" });
  });

  it("stringifies a nested object to \"[object Object]\" — total data loss", () => {
    // Every key and value inside `filter` is gone at route-table.ts:252. There
    // is no decoding this back; the only fix is at the encoder.
    expect(encodeAsLinkWould({ filter: { status: "active" } })).toBe(
      "?filter=%5Bobject+Object%5D",
    );
    expectRoundTrip({ filter: { status: "active" } }, { filter: "[object Object]" });
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
  it("never sees a repeated key from this package's own encoder", () => {
    // Why the option is safe: `queryStringOf` iterates `Object.entries`
    // (route-table.ts:251), so a key appears at most once. `?tag=a&tag=b` can
    // only come from a URL warlock did not write, which means no setting of
    // this flag can put the decoder out of step with the encoder.
    expect(encodeAsLinkWould({ tag: "a", other: "b" })).toBe("?tag=a&other=b");
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
