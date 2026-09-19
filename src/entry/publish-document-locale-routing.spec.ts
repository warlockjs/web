import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishLocaleRouting } from "../routing/locale-routing";
import { LOCALE_ROUTING_META_NAME } from "../routing/locale-routing-meta-name";
import { publishDocumentLocaleRouting } from "./publish-document-locale-routing";

/**
 * The suite runs in `node` (no real DOM) — `document.querySelector` is
 * stubbed per test, mirroring `client/hydrate-page.spec.ts`'s
 * `installFakeDocument` pattern. What is under test here is only the WIRING:
 * that the meta's parsed content — or the fallback, when the meta is absent
 * or malformed — is what reaches `publishLocaleRouting`. Parsing/validation
 * itself is `parse-locale-routing-meta.spec.ts`'s job.
 */
vi.mock("../routing/locale-routing", async () => {
  const actual = await vi.importActual<typeof import("../routing/locale-routing")>(
    "../routing/locale-routing",
  );
  return { ...actual, publishLocaleRouting: vi.fn() };
});

const FALLBACK = { strategy: "none", codes: [], defaultLocale: "" } as const;

function stubMetaContent(content: string | null): void {
  vi.stubGlobal("document", {
    querySelector(selector: string) {
      if (selector !== `meta[name="${LOCALE_ROUTING_META_NAME}"]`) return null;
      if (content === null) return null;
      return { getAttribute: () => content };
    },
  });
}

beforeEach(() => {
  vi.mocked(publishLocaleRouting).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("publishDocumentLocaleRouting", () => {
  it("publishes the parsed meta value when the meta tag is present and valid", () => {
    stubMetaContent(
      '{"strategy":"prefix-except-default","codes":["en","ar"],"defaultLocale":"en"}',
    );

    publishDocumentLocaleRouting(FALLBACK);

    expect(publishLocaleRouting).toHaveBeenCalledWith({
      strategy: "prefix-except-default",
      codes: ["en", "ar"],
      defaultLocale: "en",
    });
  });

  it("falls back to the build-time value when the meta tag is absent", () => {
    stubMetaContent(null);

    publishDocumentLocaleRouting(FALLBACK);

    expect(publishLocaleRouting).toHaveBeenCalledWith(FALLBACK);
  });

  it("falls back to the build-time value when the meta content is malformed", () => {
    stubMetaContent("{not json");

    publishDocumentLocaleRouting(FALLBACK);

    expect(publishLocaleRouting).toHaveBeenCalledWith(FALLBACK);
  });
});
