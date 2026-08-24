import { describe, expect, it } from "vitest";
import {
  EmptyLayoutChainEntryError,
  NestedLayoutsNotSupportedError,
  selectPageLayout,
} from "./layout-policy";

/** A layout that renders — one whose module has a default export. */
function renders(layout: string) {
  return { layout, renders: true };
}

/** A layout that renders nothing — `prefix`/`middleware` only, no default export. */
function rendersNothing(layout: string) {
  return { layout, renders: false };
}

describe("selectPageLayout", () => {
  it("selects none for an empty chain", () => {
    expect(selectPageLayout([])).toEqual({ type: "none" });
  });

  it("selects the sole rendering layout for a single-element chain", () => {
    expect(selectPageLayout([renders("src/app/main/web/layout.tsx")])).toEqual({
      type: "selected",
      layout: "src/app/main/web/layout.tsx",
    });
  });

  it("rejects a chain of two RENDERING layouts, carrying both in order", () => {
    expect(
      selectPageLayout([
        renders("src/app/main/web/layout.tsx"),
        renders("src/app/main/web/account/layout.tsx"),
      ]),
    ).toEqual({
      type: "rejected",
      layouts: ["src/app/main/web/layout.tsx", "src/app/main/web/account/layout.tsx"],
    });
  });

  it("rejects a chain of three RENDERING layouts, carrying all three in order", () => {
    expect(
      selectPageLayout([
        renders("src/app/main/web/layout.tsx"),
        renders("src/app/main/web/account/layout.tsx"),
        renders("src/app/main/web/account/settings/layout.tsx"),
      ]),
    ).toEqual({
      type: "rejected",
      layouts: [
        "src/app/main/web/layout.tsx",
        "src/app/main/web/account/layout.tsx",
        "src/app/main/web/account/settings/layout.tsx",
      ],
    });
  });

  it("rejects an empty-string element with a named input-contract error", () => {
    expect(() => selectPageLayout([renders("src/app/main/web/layout.tsx"), renders("")])).toThrow(
      EmptyLayoutChainEntryError,
    );
  });

  it("rejects an empty-string element however the entry was spelled", () => {
    expect(() => selectPageLayout(["src/app/main/web/layout.tsx", ""])).toThrow(
      EmptyLayoutChainEntryError,
    );
    expect(() => selectPageLayout([rendersNothing("")])).toThrow(EmptyLayoutChainEntryError);
  });
});

describe("selectPageLayout — the rule counts RENDERING layouts, not files", () => {
  // The defect this replaced: the policy counted chain elements, so an
  // authorization boundary that renders nothing — `prefix` + `middleware`, no
  // default export — was rejected exactly as if it were a second wrapper.
  it("accepts a rendering layout nested under a non-rendering one", () => {
    expect(
      selectPageLayout([
        rendersNothing("src/app/users/web/layout.tsx"),
        renders("src/app/users/web/account/layout.tsx"),
      ]),
    ).toEqual({ type: "selected", layout: "src/app/users/web/account/layout.tsx" });
  });

  it("accepts a non-rendering layout nested under a rendering one", () => {
    expect(
      selectPageLayout([
        renders("src/app/users/web/layout.tsx"),
        rendersNothing("src/app/users/web/account/layout.tsx"),
      ]),
    ).toEqual({ type: "selected", layout: "src/app/users/web/layout.tsx" });
  });

  it("composes non-rendering layouts freely — any number of them selects none", () => {
    expect(
      selectPageLayout([
        rendersNothing("src/app/users/web/layout.tsx"),
        rendersNothing("src/app/users/web/account/layout.tsx"),
        rendersNothing("src/app/users/web/account/settings/layout.tsx"),
      ]),
    ).toEqual({ type: "none" });
  });

  it("names ONLY the rendering layouts in a rejection, never the guards between them", () => {
    expect(
      selectPageLayout([
        renders("src/app/users/web/layout.tsx"),
        rendersNothing("src/app/users/web/account/layout.tsx"),
        renders("src/app/users/web/account/settings/layout.tsx"),
      ]),
    ).toEqual({
      type: "rejected",
      layouts: [
        "src/app/users/web/layout.tsx",
        "src/app/users/web/account/settings/layout.tsx",
      ],
    });
  });

  it("treats a bare string entry as a rendering layout — the conservative default", () => {
    // Callers that have not yet classified their chain keep today's behaviour
    // exactly: an unclassified layout is assumed to render.
    expect(selectPageLayout(["src/app/main/web/layout.tsx"])).toEqual({
      type: "selected",
      layout: "src/app/main/web/layout.tsx",
    });
    expect(
      selectPageLayout(["src/app/main/web/layout.tsx", "src/app/main/web/account/layout.tsx"]),
    ).toEqual({
      type: "rejected",
      layouts: ["src/app/main/web/layout.tsx", "src/app/main/web/account/layout.tsx"],
    });
  });
});

describe("NestedLayoutsNotSupportedError — the one error contract for a rejection", () => {
  // The policy returns a rejection as data; this class is what every caller
  // raises when it refuses that rejection. One class, one message shape —
  // a caller supplies only the page identity and the rejected RENDERING chain.
  it("names the page, every rendering layout, and the consolidate remedy", () => {
    const error = new NestedLayoutsNotSupportedError("src/app/main/web/account/settings.page.tsx", [
      "src/app/main/web/layout.tsx",
      "src/app/main/web/account/layout.tsx",
    ]);

    expect(error.name).toBe("NestedLayoutsNotSupportedError");
    expect(error.message).toContain('"src/app/main/web/account/settings.page.tsx"');
    expect(error.message).toContain('"src/app/main/web/layout.tsx"');
    expect(error.message).toContain('"src/app/main/web/account/layout.tsx"');
    expect(error.message).toContain("consolidate");
    expect(error.pageFile).toBe("src/app/main/web/account/settings.page.tsx");
    expect(error.layoutFiles).toEqual([
      "src/app/main/web/layout.tsx",
      "src/app/main/web/account/layout.tsx",
    ]);
  });

  it("says RENDERING, and never tells the reader to delete a middleware-only layout", () => {
    const error = new NestedLayoutsNotSupportedError("src/app/main/web/account/settings.page.tsx", [
      "src/app/main/web/layout.tsx",
      "src/app/main/web/account/layout.tsx",
    ]);

    expect(error.message).toContain("render");
    // The old wording — "remove or consolidate the extra layout" — sent app
    // authors to delete an authorization boundary to make the build pass.
    expect(error.message).not.toContain("remove or consolidate");
    expect(error.message).toContain("do not remove a middleware-only layout");
  });

  it("keeps the wording every other door already asserts on", () => {
    // `install-page-routes-from-manifest` raises this same class at boot and
    // its suite matches on this phrase; one class, one message shape means the
    // phrase cannot fork per caller.
    const error = new NestedLayoutsNotSupportedError("src/app/main/web/dashboard.page.tsx", [
      "src/app/main/web/layout.tsx",
      "src/app/main/web/dashboard/layout.tsx",
    ]);

    expect(error.message).toContain("more than one layout on its path");
  });
});
