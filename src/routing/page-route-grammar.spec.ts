import { describe, expect, it } from "vitest";
import { PageRoutePathNotSupportedError, classifyPageRoutePath } from "./page-route-grammar";

// Asserts the verdict is a rejection and hands back its reason so each test
// can additionally pin what the reason names.
function reasonFor(path: string): string {
  const verdict = classifyPageRoutePath(path);
  expect(verdict.type).toBe("rejected");
  return verdict.type === "rejected" ? verdict.reason : "";
}

// The catch-all fixtures below are the distinct route patterns from a
// 22-case probe that exercised the live server registry and client matcher
// against real URLs. Several probe cases share one pattern (they differ only
// by the URL exercised, or pair two patterns to check precedence); each
// distinct pattern appears once here, with the case ids it represents noted
// above it.

describe("classifyPageRoutePath — allowed shapes", () => {
  it("allows the root path `/`", () => {
    expect(classifyPageRoutePath("/")).toEqual({ type: "allowed" });
  });

  // Probe cases: known-wins-root-star-first, root-star-fallback-root-star-first,
  // known-wins-static-first, root-star-fallback-static-first (pattern `/known`).
  it("allows a single static segment `/known`", () => {
    expect(classifyPageRoutePath("/known")).toEqual({ type: "allowed" });
  });

  // Probe cases: prefix-static-wins-wildcard-first,
  // prefix-wildcard-fallback-wildcard-first, prefix-static-wins-static-first,
  // prefix-wildcard-fallback-static-first (pattern `/prefix/static`).
  it("allows a multi-segment static path `/prefix/static`", () => {
    expect(classifyPageRoutePath("/prefix/static")).toEqual({ type: "allowed" });
  });

  it("allows `/users/settings`", () => {
    expect(classifyPageRoutePath("/users/settings")).toEqual({ type: "allowed" });
  });

  it("allows a whole-segment param `/users/:id`", () => {
    expect(classifyPageRoutePath("/users/:id")).toEqual({ type: "allowed" });
  });

  it("allows a whole-segment param between static segments `/a/:b/c`", () => {
    expect(classifyPageRoutePath("/a/:b/c")).toEqual({ type: "allowed" });
  });

  // Probe cases: root-star-root, root-star-tail, root-star-tail-trailing-slash,
  // known-wins-root-star-first, root-star-fallback-root-star-first,
  // known-wins-static-first, root-star-fallback-static-first (pattern `*`).
  it("allows the exact root wildcard `*` — the one path without a leading slash", () => {
    expect(classifyPageRoutePath("*")).toEqual({ type: "allowed" });
  });

  // Probe cases: slash-star-root, slash-star-tail,
  // slash-star-tail-trailing-slash (pattern `/*`).
  it("allows `/*`", () => {
    expect(classifyPageRoutePath("/*")).toEqual({ type: "allowed" });
  });

  // Probe cases: prefix-star-exact-boundary, prefix-star-boundary-trailing-slash,
  // prefix-star-one-segment, prefix-star-multi-segment,
  // prefix-star-tail-trailing-slash, prefix-static-wins-wildcard-first,
  // prefix-wildcard-fallback-wildcard-first, prefix-static-wins-static-first,
  // prefix-wildcard-fallback-static-first (pattern `/prefix/*`).
  it("allows a terminal whole-segment catch-all `/prefix/*`", () => {
    expect(classifyPageRoutePath("/prefix/*")).toEqual({ type: "allowed" });
  });

  it("allows a deeper terminal catch-all `/a/b/*`", () => {
    expect(classifyPageRoutePath("/a/b/*")).toEqual({ type: "allowed" });
  });
});

describe("classifyPageRoutePath — rejected shapes", () => {
  it("rejects a regex param `/users/:id(\\d+)`, naming the segment and the plain-param fix", () => {
    const reason = reasonFor("/users/:id(\\d+)");
    expect(reason).toContain(':id(\\d+)');
    expect(reason).toMatch(/regex/i);
    expect(reason).toContain(":id");
  });

  it("rejects an optional param `/users/:id?`, naming the segment and the two-pages fix", () => {
    const reason = reasonFor("/users/:id?");
    expect(reason).toContain(":id?");
    expect(reason).toMatch(/optional/i);
    expect(reason).toMatch(/two pages/i);
  });

  it("rejects multiple params in one segment `/near/:lat-:lng`, naming the split fix", () => {
    const reason = reasonFor("/near/:lat-:lng");
    expect(reason).toContain(":lat-:lng");
    expect(reason).toMatch(/more than one param/i);
    expect(reason).toContain(":lat/:lng");
  });

  it("rejects a static-suffix param `/file/:name.png`, naming the whole-segment fix", () => {
    const reason = reasonFor("/file/:name.png");
    expect(reason).toContain(":name.png");
    expect(reason).toMatch(/whole segment/i);
  });

  it("rejects a static-prefix param `/pre:id`", () => {
    const reason = reasonFor("/pre:id");
    expect(reason).toContain("pre:id");
    expect(reason).toMatch(/whole segment/i);
  });

  it("rejects an escaped colon `/path/\\:literal`", () => {
    const reason = reasonFor("/path/\\:literal");
    expect(reason).toContain("\\:literal");
    expect(reason).toMatch(/backslash/i);
  });

  // Probe cases: broader-prefix-star-empty-tail, broader-prefix-star-adjacent-tail,
  // broader-prefix-star-slash-tail (pattern `/a/prefix*`) — this broader form
  // is outside the page grammar and is rejected here.
  it("rejects a broad suffix wildcard `/a/prefix*`, naming the whole-segment fix", () => {
    const reason = reasonFor("/a/prefix*");
    expect(reason).toContain("prefix*");
    expect(reason).toContain('"/prefix/*"');
  });

  it("rejects a broad suffix wildcard `/files/report*`", () => {
    const reason = reasonFor("/files/report*");
    expect(reason).toContain("report*");
  });

  it("rejects a non-terminal wildcard `/a/*/b`, pointing at the terminal position", () => {
    const reason = reasonFor("/a/*/b");
    expect(reason).toContain('"/a/*/b"');
    expect(reason).toMatch(/final segment/i);
  });

  it("rejects a path missing its leading slash, suggesting the slash-led form", () => {
    const reason = reasonFor("users/settings");
    expect(reason).toContain('"users/settings"');
    expect(reason).toContain('"/users/settings"');
  });

  it("rejects an empty path, suggesting `/` for the site root", () => {
    const reason = reasonFor("");
    expect(reason).toContain('"/"');
  });

  it("rejects an empty internal segment `/a//b`", () => {
    const reason = reasonFor("/a//b");
    expect(reason).toContain('"/a//b"');
    expect(reason).toMatch(/doubled slash/i);
  });

  it("rejects a trailing slash `/users/`, suggesting the slash-free form", () => {
    const reason = reasonFor("/users/");
    expect(reason).toContain('"/users/"');
    expect(reason).toContain('"/users"');
  });
});

describe("PageRoutePathNotSupportedError — the one error contract for a rejection", () => {
  // The predicate returns a rejection as data; this class is what every
  // caller raises when it refuses that rejection. One class, one message
  // shape — a caller supplies only the page identity and the verdict's data.
  it("names the file, the path, the reason, and the narrower-grammar framing", () => {
    const verdict = classifyPageRoutePath("/users/:id?");
    const reason = verdict.type === "rejected" ? verdict.reason : "";
    const error = new PageRoutePathNotSupportedError(
      "src/app/main/web/users/[id].page.tsx",
      "/users/:id?",
      reason,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PageRoutePathNotSupportedError");
    expect(error.pageFile).toBe("src/app/main/web/users/[id].page.tsx");
    expect(error.routePath).toBe("/users/:id?");
    expect(error.reason).toBe(reason);
    expect(error.message).toContain('"src/app/main/web/users/[id].page.tsx"');
    expect(error.message).toContain('"/users/:id?"');
    expect(error.message).toContain(reason);
    expect(error.message).toContain("narrower grammar than API routes");
  });
});
