import config from "@mongez/config";
import { afterEach, describe, expect, it } from "vitest";
import { PageRedirectSignal } from "./page-redirect-signal";
import { requireUser } from "./require-user";
import type { PipelineLoaderContext } from "../server/execute-page-request.types";

function ctx(
  session: PipelineLoaderContext["session"],
  request: Record<string, unknown> = {},
): PipelineLoaderContext {
  return {
    request: { url: "/account?tab=1", locale: "en", authorizationValue: undefined, ...request },
    signal: new AbortController().signal,
    session,
  } as unknown as PipelineLoaderContext;
}

afterEach(() => {
  config.set("auth.pageAuth.loginPath", undefined);
});

describe("requireUser loader form", () => {
  it("returns the model for a signed-in user", () => {
    const model = { id: 1 };

    expect(requireUser(ctx({ user: { id: 1 }, model }))).toBe(model);
  });

  it("throws a PageRedirectSignal to the login path for a guest", () => {
    try {
      requireUser(ctx({ user: null, model: null }), { loginPath: "/login" });
      expect.unreachable();
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(PageRedirectSignal);
      expect((thrown as PageRedirectSignal).statusCode).toBe(302);
      expect((thrown as PageRedirectSignal).url).toBe(
        `/login?redirect=${encodeURIComponent("/account?tab=1")}`,
      );
    }
  });

  it("throws a 401 for a bearer client or when no loginPath is set", () => {
    expect(() => requireUser(ctx({ user: null, model: null }))).toThrow(/Unauthorized/);
    expect(() =>
      requireUser(ctx({ user: null, model: null }, { authorizationValue: "Bearer x" }), {
        loginPath: "/login",
      }),
    ).toThrow(/Unauthorized/);
  });

  it("throws a 403 when userType or when fails", () => {
    const signedIn = ctx({ user: { id: 1 }, model: { userType: "user" } });

    expect(() => requireUser(signedIn, { userType: "admin" })).toThrow(/Forbidden/);
    expect(() => requireUser(signedIn, { when: () => false })).toThrow(/Forbidden/);
    expect(requireUser(signedIn, { userType: "user", when: () => true })).toEqual({
      userType: "user",
    });
  });
});

describe("requireUser middleware form", () => {
  it("still returns a middleware function", () => {
    expect(typeof requireUser({ loginPath: "/login" })).toBe("function");
    expect(typeof requireUser()).toBe("function");
  });
});
