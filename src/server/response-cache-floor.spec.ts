import { describe, expect, it, vi } from "vitest";
import type { Response } from "@warlock.js/core";

import { applyResponseCacheFloor, carriesSetCookie } from "./response-cache-floor";

function responseWithHeader(getHeader: ((key: string) => unknown) | undefined) {
  return {
    getHeader,
    header: vi.fn(),
  } as unknown as Response;
}

describe("carriesSetCookie", () => {
  it("returns false when the response has no getHeader at all (the mock case)", () => {
    const response = responseWithHeader(undefined);

    expect(carriesSetCookie(response)).toBe(false);
  });

  it("returns false when the set-cookie header is an empty array", () => {
    const response = responseWithHeader(() => []);

    expect(carriesSetCookie(response)).toBe(false);
  });

  it("returns false when the set-cookie header is an empty string", () => {
    const response = responseWithHeader(() => "");

    expect(carriesSetCookie(response)).toBe(false);
  });

  it("returns true when the set-cookie header is a non-empty string", () => {
    const response = responseWithHeader(() => "token=abc");

    expect(carriesSetCookie(response)).toBe(true);
  });

  it("returns true when the set-cookie header is a non-empty array", () => {
    const response = responseWithHeader(() => ["token=abc"]);

    expect(carriesSetCookie(response)).toBe(true);
  });
});

describe("applyResponseCacheFloor", () => {
  it("sets private, no-store when authDerived is true", () => {
    const response = responseWithHeader(() => undefined);

    applyResponseCacheFloor(response, { authDerived: true });

    expect(response.header).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });

  it("sets private, no-store when the response carries a Set-Cookie", () => {
    const response = responseWithHeader(() => "token=abc");

    applyResponseCacheFloor(response, { authDerived: false });

    expect(response.header).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });

  it("sets no-store (the closed-by-default answer) when neither authDerived nor a Set-Cookie is present and the route declared no cache opt-in", () => {
    const response = responseWithHeader(() => undefined);

    applyResponseCacheFloor(response, { authDerived: false });

    expect(response.header).toHaveBeenCalledWith("Cache-Control", "no-store");
  });

  it("sets public, max-age=<maxAge> when the route opted in and neither floor triggers", () => {
    const response = responseWithHeader(() => undefined);

    applyResponseCacheFloor(response, {
      authDerived: false,
      cache: { public: true, maxAge: 120 },
    });

    expect(response.header).toHaveBeenCalledWith("Cache-Control", "public, max-age=120");
  });

  it("still sets private, no-store when authDerived is true even though the route opted in — the floor beats the opt-in", () => {
    const response = responseWithHeader(() => undefined);

    applyResponseCacheFloor(response, {
      authDerived: true,
      cache: { public: true, maxAge: 120 },
    });

    expect(response.header).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });

  it("still sets private, no-store when the response carries a Set-Cookie even though the route opted in — the floor beats the opt-in", () => {
    const response = responseWithHeader(() => "token=abc");

    applyResponseCacheFloor(response, {
      authDerived: false,
      cache: { public: true, maxAge: 120 },
    });

    expect(response.header).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });
});
