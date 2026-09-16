// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { syncDocumentLocale } from "./sync-document-locale";

/**
 * `syncDocumentLocale` — the correction `document.documentElement` needs
 * after a client-side locale swap, because `root.tsx` sits outside the
 * hydrated subtree and no client render can reach it directly
 * (`skills/write-the-root/SKILL.md`). Proven here in isolation, with the
 * wiring into `NavigationRoot` proven separately in
 * `navigation-root-document.spec.ts`.
 */

afterEach(() => {
  document.documentElement.lang = "";
  document.documentElement.dir = "";
});

describe("syncDocumentLocale", () => {
  it("sets lang and the resolved rtl direction for an rtl locale", () => {
    document.documentElement.lang = "en";
    document.documentElement.dir = "ltr";

    syncDocumentLocale(document, "ar");

    expect(document.documentElement.lang).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
  });

  it("sets lang and the resolved ltr direction for an ltr locale", () => {
    document.documentElement.lang = "ar";
    document.documentElement.dir = "rtl";

    syncDocumentLocale(document, "en");

    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("leaves matching attributes alone instead of rewriting them", () => {
    document.documentElement.lang = "fr";
    document.documentElement.dir = "ltr";

    syncDocumentLocale(document, "fr");

    expect(document.documentElement.lang).toBe("fr");
    expect(document.documentElement.dir).toBe("ltr");
  });
});
