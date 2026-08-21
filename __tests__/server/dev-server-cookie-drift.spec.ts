import { describe, expect, it, vi } from "vitest";
import { Response } from "../../../core/src/http/response";
import { applyBufferedCookie } from "../../src/server/dev-server";
import type { BufferedCookie } from "../../src/server/buffered-response";

/**
 * Board task `9ccb2e63` (Suki, room seq 1511; C3 §8-A, canon `f9d9a5cc`).
 *
 * Production commits a `BufferedCookie` via core's real `Response.cookie()`
 * (`web/src/server/execute-page-request.ts:317`:
 * `realResponse.cookie(cookie.name, cookie.value, cookie.options)`, itself
 * writing straight to `baseResponse.setCookie` — `baseResponse` IS the real
 * `FastifyReply`, core/src/http/response.ts:960). Dev-server replays the SAME
 * `BufferedCookie` a different way (`applyBufferedCookie`,
 * `web/src/server/dev-server.ts`), because it never has a loader-facing
 * `Response` in scope, only the buffered commit. This spec is the check that
 * those two paths agree byte-for-byte on what reaches fastify's `setCookie`
 * — not "visually similar", the literal `(name, value, options)` tuple.
 *
 * Every fixture below fully specifies every field `secureCookieDefaults()`
 * would otherwise supply (`httpOnly`/`sameSite`/`secure`) — per-call options
 * are the highest-precedence layer in core's `cookie()`
 * (core/src/http/response.ts:960-964), so a fully-specified per-call bag
 * makes that merge a no-op and this test does not depend on
 * `secureCookieDefaults()` or `http.cookies.options` at all. Whether
 * dev-server's replay should ALSO apply those framework-level defaults is
 * board task `d8ef6d01`, deliberately not this one.
 */

/** Captures the exact `(name, value, options)` fastify's `setCookie` receives. */
function createReplyStub() {
  const setCookie = vi.fn();
  return { setCookie, raw: { once: vi.fn() } } as unknown as import("fastify").FastifyReply & {
    setCookie: typeof setCookie;
  };
}

function productionSetCookieCall(cookie: BufferedCookie): unknown[] {
  const reply = createReplyStub();
  const response = new Response();

  response.setResponse(reply);
  response.cookie(cookie.name, cookie.value as never, (cookie.options ?? {}) as never);

  return (reply.setCookie as ReturnType<typeof vi.fn>).mock.calls[0];
}

function devReplaySetCookieCall(cookie: BufferedCookie): unknown[] {
  const reply = createReplyStub();

  applyBufferedCookie(reply, cookie);

  return (reply.setCookie as ReturnType<typeof vi.fn>).mock.calls[0];
}

describe("dev-server cookie replay — drift against core's real serializer", () => {
  it("matches production byte-for-byte for the locale cookie shape (raw, C3 §8-A maxAge)", () => {
    const cookie: BufferedCookie = {
      name: "locale",
      value: "en-US",
      options: {
        raw: true,
        maxAge: 31536000, // C3 §8-A, canon f9d9a5cc — seconds, unconverted on both sides
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: true,
      },
    };

    expect(devReplaySetCookieCall(cookie)).toEqual(productionSetCookieCall(cookie));
  });

  it("matches production for a JSON-wrapped (non-raw) plain string value", () => {
    // This is the case `String(cookie.value)` (what this file replaces) got
    // wrong: production JSON-quotes a non-raw string; `String()` would not.
    const cookie: BufferedCookie = {
      name: "theme",
      value: "dark",
      options: { maxAge: 3600, path: "/", httpOnly: true, sameSite: "lax", secure: true },
    };

    const production = productionSetCookieCall(cookie);
    const devReplay = devReplaySetCookieCall(cookie);

    expect(devReplay).toEqual(production);
    expect(production[1]).toBe(JSON.stringify("dark"));
  });

  it("matches production for a JSON-wrapped structured value", () => {
    const cookie: BufferedCookie = {
      name: "prefs",
      value: { theme: "dark", locale: "en-US" },
      options: { maxAge: 3600, path: "/", httpOnly: true, sameSite: "lax", secure: true },
    };

    expect(devReplaySetCookieCall(cookie)).toEqual(productionSetCookieCall(cookie));
  });

  it("drops core-only `raw` from the options fastify receives, on both paths", () => {
    const cookie: BufferedCookie = {
      name: "session",
      value: "abc.def.ghi",
      options: { raw: true, httpOnly: true, sameSite: "lax", secure: true },
    };

    const [, , productionOptions] = productionSetCookieCall(cookie);
    const [, , devReplayOptions] = devReplaySetCookieCall(cookie);

    expect(productionOptions).not.toHaveProperty("raw");
    expect(devReplayOptions).not.toHaveProperty("raw");
    expect(devReplayOptions).toEqual(productionOptions);
  });
});
