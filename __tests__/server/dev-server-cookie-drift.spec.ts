import { describe, expect, it, vi } from "vitest";
import { Request } from "../../../core/src/http/request";
import { Response } from "../../../core/src/http/response";
import { applyBufferedCookie } from "../../src/server/dev-server";
import type { BufferedCookie } from "../../src/server/buffered-response";

/**
 * `applyBufferedCookie` commits a `BufferedCookie` by calling core's
 * `Response.cookie()` — the same method `execute-page-request.ts` uses for the
 * production commit and every ordinary controller uses for its own cookies.
 * There is no second serializer left to drift from, so what this spec checks is
 * no longer "do two implementations agree" but the thing that actually matters:
 * that a cookie written through the buffer READS BACK as the value the loader
 * put in it, via core's `Request.cookie()`.
 *
 * Every fixture fully specifies the fields `secureCookieDefaults()` would
 * otherwise supply (`httpOnly`/`sameSite`/`secure`) — per-call options are the
 * highest-precedence layer in `Response.cookie()`, so a fully-specified bag
 * makes that merge a no-op and this spec does not depend on
 * `secureCookieDefaults()` or on `http.cookies.options`.
 *
 * Percent-encoding is deliberately out of frame: fastify's `setCookie` applies
 * it on the way out and parses it off on the way in, symmetrically, below
 * anything either core method controls.
 */

/** Captures the exact `(name, value, options)` fastify's `setCookie` receives. */
function createReplyStub() {
  const setCookie = vi.fn();
  return { setCookie, raw: { once: vi.fn() } } as unknown as Parameters<
    Response["setResponse"]
  >[0] & { setCookie: typeof setCookie };
}

/** The `(name, value, options)` tuple `applyBufferedCookie` puts on the wire. */
function committedSetCookieCall(cookie: BufferedCookie): [string, string, Record<string, unknown>] {
  const reply = createReplyStub();
  const response = new Response();

  response.setResponse(reply);
  applyBufferedCookie(response, cookie);

  return reply.setCookie.mock.calls[0] as [string, string, Record<string, unknown>];
}

/** Read a wire value back the way an incoming request would. */
function readBack(name: string, wireValue: string): unknown {
  const request = new Request();

  // `headers` is present because `setRequest` resolves the request id off it.
  request.setRequest({ cookies: { [name]: wireValue }, headers: {} } as never);

  return request.cookie(name);
}

describe("buffered cookie commit — round-trips through core's own serializer", () => {
  it("round-trips a raw string cookie unquoted (the locale cookie shape)", () => {
    const cookie: BufferedCookie = {
      name: "locale",
      value: "en-US",
      options: {
        raw: true,
        maxAge: 31536000, // seconds — the unit both core and fastify use, unconverted
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: true,
      },
    };

    const [name, wireValue, options] = committedSetCookieCall(cookie);

    expect(name).toBe("locale");
    expect(wireValue).toBe("en-US");
    expect(options.maxAge).toBe(31536000);
    expect(options.path).toBe("/");
    expect(readBack(name, wireValue)).toBe("en-US");
  });

  it("round-trips a non-raw plain string, JSON-quoted on the wire", () => {
    const cookie: BufferedCookie = {
      name: "theme",
      value: "dark",
      options: { maxAge: 3600, path: "/", httpOnly: true, sameSite: "lax", secure: true },
    };

    const [name, wireValue] = committedSetCookieCall(cookie);

    expect(wireValue).toBe(JSON.stringify("dark"));
    expect(readBack(name, wireValue)).toBe("dark");
  });

  it("round-trips a structured value", () => {
    const value = { theme: "dark", locale: "en-US" };
    const cookie: BufferedCookie = {
      name: "prefs",
      value,
      options: { maxAge: 3600, path: "/", httpOnly: true, sameSite: "lax", secure: true },
    };

    const [name, wireValue] = committedSetCookieCall(cookie);

    expect(readBack(name, wireValue)).toEqual(value);
  });

  it("drops the core-only `raw` flag from the options fastify receives", () => {
    const cookie: BufferedCookie = {
      name: "session",
      value: "abc.def.ghi",
      options: { raw: true, httpOnly: true, sameSite: "lax", secure: true },
    };

    const [, wireValue, options] = committedSetCookieCall(cookie);

    expect(options).not.toHaveProperty("raw");
    expect(wireValue).toBe("abc.def.ghi");
  });
});
