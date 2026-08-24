import { describe, expect, it } from "vitest";
import { resolveValidationData } from "./resolve-validation-data";

/*
  The defect @Hasan spotted from one line of `execute-page-request.ts`.

  Stage 4 built its validation input from FOUR sources, and took them from TWO
  different places:

      body    → request.body      ✅ core's parse
      headers → request.headers   ✅ core's parse
      query   → match.query       ❌ Object.fromEntries(new URLSearchParams(…))
      params  → match.params      ❌ re-derived by web's own matcher

  Core's parser is bracket-aware and keeps repeated keys. `URLSearchParams` +
  `fromEntries` is neither:

      ?tags=a&tags=b&filter[status]=active
        core  → { tags: ["a","b"], filter: { status: "active" } }
        match → { tags: "b", "filter[status]": "active" }

  So a page's validation rules were checking DIFFERENT DATA than its loader
  received. A rule on `filter.status` could never fire — validation saw a key
  literally named `filter[status]` — and with a repeated key only the last
  value was ever examined. A field the author believed was validated was not,
  and nothing about that is visible from reading the validation rules.

  One request, one parse, one grammar. All four sources come from the request.
*/

const request = {
  body: { title: "hello" },
  headers: { "x-trace": "abc" },
  // core's shape: nested, and repeated keys preserved
  query: { tags: ["a", "b"], filter: { status: "active" } },
  params: { id: "42" },
};

/** The lossy shape stage 4 used to read. Present only to prove it is unused. */
const match = {
  query: { tags: "b", "filter[status]": "active" },
  params: { id: "42" },
};

describe("resolveValidationData — every source is the request", () => {
  it("takes query from the request, not a re-parsed URL", () => {
    const data = resolveValidationData(["query"], request);

    expect(data).toEqual({ tags: ["a", "b"], filter: { status: "active" } });
  });

  it("keeps a repeated key's first value", () => {
    const data = resolveValidationData(["query"], request);

    // `?tags=a&tags=b` used to arrive as "b" — `a` silently deleted.
    expect(data.tags).toEqual(["a", "b"]);
  });

  it("gives validation a nested object, not a key named 'filter[status]'", () => {
    const data = resolveValidationData(["query"], request);

    expect(data.filter).toEqual({ status: "active" });
    expect(data).not.toHaveProperty("filter[status]");
  });

  it("takes params from the request", () => {
    expect(resolveValidationData(["params"], request)).toEqual({ id: "42" });
  });

  it("still takes body and headers from the request", () => {
    expect(resolveValidationData(["body"], request)).toEqual({ title: "hello" });
    expect(resolveValidationData(["headers"], request)).toEqual({ "x-trace": "abc" });
  });
});

describe("resolveValidationData — the page default", () => {
  /*
    A page validates params + query by default, not body — a page load is a GET.
    That default must read the same sources as the explicit list, or the
    defect just moves.
  */
  it("defaults to query + params, both from the request", () => {
    const data = resolveValidationData(undefined, request);

    expect(data).toEqual({ tags: ["a", "b"], filter: { status: "active" }, id: "42" });
  });

  it("treats an empty list as the default", () => {
    expect(resolveValidationData([], request)).toEqual(
      resolveValidationData(undefined, request),
    );
  });

  it("lets params win over a query key of the same name", () => {
    const collide = { ...request, query: { id: "from-query" }, params: { id: "from-params" } };

    expect(resolveValidationData(undefined, collide)).toEqual({ id: "from-params" });
  });
});

describe("resolveValidationData — absent sources", () => {
  it("does not invent keys when the request carries nothing", () => {
    expect(resolveValidationData(undefined, {})).toEqual({});
  });

  it("ignores a source name it does not know", () => {
    expect(resolveValidationData(["nonsense"], request)).toEqual({});
  });
});
