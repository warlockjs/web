import { describe, expect, it } from "vitest";
import {
  fragmentOf,
  fragmentTargetId,
  samePageFragment,
  withFragmentFrom,
  withoutFragment,
} from "./url-fragment";

/**
 * The fragment rules a client navigation has to reproduce, because `fetch`
 * throws the fragment away before the runtime ever sees the response.
 *
 * The cases that matter are the ones where "no fragment" and "an empty
 * fragment" are different answers, and where a fragment must NOT be treated as
 * a navigation at all.
 */
describe("fragmentOf", () => {
  it("reads the fragment without its hash", () => {
    expect(fragmentOf("/docs#install")).toBe("install");
  });

  it("distinguishes no fragment from an empty one", () => {
    expect(fragmentOf("/docs")).toBeUndefined();
    expect(fragmentOf("/docs#")).toBe("");
  });

  it("keeps everything after the FIRST hash", () => {
    expect(fragmentOf("/docs#a#b")).toBe("a#b");
  });

  it("reads a bare fragment", () => {
    expect(fragmentOf("#install")).toBe("install");
  });
});

describe("withoutFragment", () => {
  it("strips from the hash onward", () => {
    expect(withoutFragment("/docs?v=5#install")).toBe("/docs?v=5");
  });

  it("returns a fragmentless url unchanged", () => {
    expect(withoutFragment("/docs?v=5")).toBe("/docs?v=5");
  });
});

describe("withFragmentFrom", () => {
  it("puts back the fragment the response url could not carry", () => {
    expect(withFragmentFrom("https://app.test/docs", "/docs#install")).toBe(
      "https://app.test/docs#install",
    );
  });

  it("leaves a fragmentless request alone", () => {
    expect(withFragmentFrom("https://app.test/docs", "/docs")).toBe("https://app.test/docs");
  });

  it("preserves an EMPTY fragment, which the author still wrote", () => {
    expect(withFragmentFrom("https://app.test/docs", "/docs#")).toBe(
      "https://app.test/docs#",
    );
  });

  it("lets a redirect's own fragment win", () => {
    expect(withFragmentFrom("https://app.test/docs/v5#moved", "/docs#install")).toBe(
      "https://app.test/docs/v5#moved",
    );
  });
});

describe("fragmentTargetId", () => {
  it("decodes percent escapes, because ids hold the decoded characters", () => {
    expect(fragmentTargetId("a%20b")).toBe("a b");
    expect(fragmentTargetId("%D8%A7%D9%84%D8%B9%D9%86%D9%88%D8%A7%D9%86")).toBe("العنوان");
  });

  it("returns a malformed escape as written rather than throwing", () => {
    expect(fragmentTargetId("100%")).toBe("100%");
  });
});

describe("samePageFragment", () => {
  const HERE = "https://app.test/docs?v=5";

  it("recognises a bare fragment", () => {
    expect(samePageFragment("#install", HERE)).toBe("install");
  });

  it("recognises the current path written out with a fragment", () => {
    expect(samePageFragment("/docs?v=5#install", HERE)).toBe("install");
  });

  it("is not a same-page jump when the path differs", () => {
    expect(samePageFragment("/guide#install", HERE)).toBeUndefined();
  });

  it("is not a same-page jump when the QUERY differs — that is different data", () => {
    expect(samePageFragment("/docs?v=4#install", HERE)).toBeUndefined();
  });

  it("is not a same-page jump without a fragment", () => {
    expect(samePageFragment("/docs?v=5", HERE)).toBeUndefined();
    expect(samePageFragment("/docs?v=5#", HERE)).toBeUndefined();
  });

  it("is not a same-page jump on another origin", () => {
    expect(samePageFragment("https://other.test/docs?v=5#install", HERE)).toBeUndefined();
  });

  it("answers undefined rather than throwing on an unparseable url", () => {
    expect(samePageFragment("http://[", HERE)).toBeUndefined();
  });
});
