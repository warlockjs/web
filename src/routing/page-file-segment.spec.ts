import { describe, expect, it } from "vitest";
import { PageFileSegmentNotSupportedError, classifyPageFileSegment } from "./page-file-segment";

// Asserts the verdict is a rejection and hands back its reason so each test
// can additionally pin what the reason names.
function reasonFor(segment: string): string {
  const verdict = classifyPageFileSegment(segment);
  expect(verdict.type).toBe("rejected");
  return verdict.type === "rejected" ? verdict.reason : "";
}

describe("classifyPageFileSegment — allowed shapes", () => {
  it("allows a whole-segment param `[id]`", () => {
    expect(classifyPageFileSegment("[id]")).toEqual({ type: "allowed" });
  });

  it("allows a plain static segment `index`", () => {
    expect(classifyPageFileSegment("index")).toEqual({ type: "allowed" });
  });

  it("allows a plain static segment `products`", () => {
    expect(classifyPageFileSegment("products")).toEqual({ type: "allowed" });
  });

  it("allows a group directory `(marketing)` — it contains no brackets", () => {
    expect(classifyPageFileSegment("(marketing)")).toEqual({ type: "allowed" });
  });

  it("allows a whole-segment param with an underscore name `[user_id]`", () => {
    expect(classifyPageFileSegment("[user_id]")).toEqual({ type: "allowed" });
  });
});

describe("classifyPageFileSegment — rejected shapes", () => {
  it("rejects a catch-all `[...slug]`, naming the segment and the supported alternative", () => {
    const reason = reasonFor("[...slug]");
    expect(reason).toContain("[...slug]");
    expect(reason).toMatch(/catch-all/i);
    expect(reason).toContain("[id]");
  });

  it("rejects a bare catch-all `[...]`", () => {
    const reason = reasonFor("[...]");
    expect(reason).toContain("[...]");
    expect(reason).toMatch(/catch-all/i);
  });

  it("rejects two bracket groups `[id].[slug]`, naming the split fix", () => {
    const reason = reasonFor("[id].[slug]");
    expect(reason).toContain("[id].[slug]");
    expect(reason).toMatch(/more than one bracket group/i);
    expect(reason).toContain("[id]/[slug]");
  });

  it("rejects two bracket groups `[a]-[b]`", () => {
    const reason = reasonFor("[a]-[b]");
    expect(reason).toContain("[a]-[b]");
    expect(reason).toMatch(/more than one bracket group/i);
  });

  it("rejects a bracket group mixed with other text `pre[id]`", () => {
    const reason = reasonFor("pre[id]");
    expect(reason).toContain("pre[id]");
    expect(reason).toMatch(/whole filesystem segment/i);
  });

  it("rejects an empty parameter name `[]`", () => {
    const reason = reasonFor("[]");
    expect(reason).toContain("[]");
    expect(reason).toMatch(/empty parameter name/i);
  });

  it("rejects a parameter name starting with a digit `[1bad]`", () => {
    const reason = reasonFor("[1bad]");
    expect(reason).toContain("[1bad]");
    expect(reason).toMatch(/parameter name/i);
  });

  it("rejects a parameter name with a hyphen `[a-b]`", () => {
    const reason = reasonFor("[a-b]");
    expect(reason).toContain("[a-b]");
    expect(reason).toMatch(/parameter name/i);
  });

  it("rejects a parameter name with a space `[a b]`", () => {
    const reason = reasonFor("[a b]");
    expect(reason).toContain("[a b]");
    expect(reason).toMatch(/parameter name/i);
  });

  it("rejects an unbalanced/stray bracket `[id`", () => {
    const reason = reasonFor("[id");
    expect(reason).toContain("[id");
    expect(reason).toMatch(/unbalanced/i);
  });
});

describe("PageFileSegmentNotSupportedError — the one error contract for a rejection", () => {
  it("names the page file, the segment, the reason, and the supported alternative", () => {
    const verdict = classifyPageFileSegment("[...slug]");
    const reason = verdict.type === "rejected" ? verdict.reason : "";
    const error = new PageFileSegmentNotSupportedError(
      "src/app/main/web/docs/[...slug].page.tsx",
      "[...slug]",
      reason,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PageFileSegmentNotSupportedError");
    expect(error.pageFile).toBe("src/app/main/web/docs/[...slug].page.tsx");
    expect(error.segment).toBe("[...slug]");
    expect(error.reason).toBe(reason);
    expect(error.message).toContain('"src/app/main/web/docs/[...slug].page.tsx"');
    expect(error.message).toContain('"[...slug]"');
    expect(error.message).toContain(reason);
    expect(error.message).toContain('"[id]"');
  });
});
