import { describe, expect, it } from "vitest";
import { hasCookieRequiringPageCacheBypass } from "./page-cache-cookie-bypass";
import type { CredentialReadableRequest } from "./page-cache-eligibility";

function requestWithCookie(value: unknown): CredentialReadableRequest {
  return {
    header: (name: string) => (name === "cookie" ? value : undefined),
  } as unknown as CredentialReadableRequest;
}

describe("hasCookieRequiringPageCacheBypass — header shape", () => {
  it("treats an absent Cookie header as cookie-free", () => {
    expect(hasCookieRequiringPageCacheBypass(requestWithCookie(undefined))).toBe(false);
  });

  it("fails closed on a present non-string Cookie header (duplicated header array)", () => {
    expect(hasCookieRequiringPageCacheBypass(requestWithCookie(["token=abc", "locale=en"]))).toBe(
      true,
    );
  });

  it("fails closed on an object-shaped Cookie header", () => {
    expect(hasCookieRequiringPageCacheBypass(requestWithCookie({ token: "abc" }))).toBe(true);
  });

  it("keeps a locale-only string header cacheable", () => {
    expect(hasCookieRequiringPageCacheBypass(requestWithCookie("locale=en"))).toBe(false);
  });

  it("allows the matching preference cookie only, while retaining the mixed-cookie bypass", () => {
    expect(
      hasCookieRequiringPageCacheBypass(
        requestWithCookie("warlock.locale-preference=ar; locale=en"),
      ),
    ).toBe(false);
    expect(
      hasCookieRequiringPageCacheBypass(requestWithCookie("warlock.locale-preference=ar; token=x")),
    ).toBe(true);
  });
});
