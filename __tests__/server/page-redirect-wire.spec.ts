import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpContext } from "@warlock.js/core";
import {
  createPageRouteHandler,
  type PageModuleLoader,
} from "../../src/server/create-page-route-handler";
import type { BufferedCookie } from "../../src/server/buffered-response";
import {
  connectPageContext,
  connectPageRoutes,
  type PageContextRunner,
  type PageRoutesRegistry,
} from "../../src/server/index";
import { connectSharedStore, type SharedStoreResolver } from "../../src/shared";
import { createCoreHttp, createReplyShim, requestContext } from "./fixtures/core-http";
import * as App from "./fixtures/root";

/**
 * A loader short-circuit, asserted AT THE WIRE.
 *
 * Every other spec that touches a loader redirect stops at the bundle
 * (`pipeline-loaders.spec.ts:228-277` asserts `bundle.shortCircuit` and the
 * committed cookie). Those assertions passed while the browser was receiving a
 * bare `302` with an empty body and no `Location` — the URL reached
 * `bundle.shortCircuit.url` and was dropped at the emit
 * (design/loader-endpoint-seam-2026-08-23.md §5). A bundle-level assertion
 * cannot see that; only the reply can.
 *
 * So this file asserts the RECORDED REPLY: `createPageRouteHandler` driven
 * against real core `Request`/`Response` instances (`createCoreHttp`), reading
 * back what the fastify reply was actually handed. Nothing is asserted about
 * the bundle except as a control — the point is the four-hop path
 * buffered-response → commit → finishRender → emit, end to end.
 */

const APP_FILE = "/fixtures/web/root.tsx";
const LAYOUT_FILE = "/fixtures/web/account.layout.tsx";
const PAGE_FILE = "/fixtures/web/guarded.page.tsx";

let previousRunner: PageContextRunner | undefined;
let previousResolver: SharedStoreResolver | undefined;
let previousRegistry: PageRoutesRegistry | undefined;

beforeAll(() => {
  previousRunner = connectPageContext(requestContext as unknown as PageContextRunner);
  previousResolver = connectSharedStore(() => requestContext.getStore() as never);
  // The handler must render off the one-entry registry it builds per request.
  previousRegistry = connectPageRoutes(undefined);
});

afterAll(() => {
  connectPageContext(previousRunner);
  connectSharedStore(previousResolver);
  connectPageRoutes(previousRegistry);
});

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * The one-liner `dev-server.ts:39` hands the handler in production, inlined
 * here so this spec's module graph stays clear of vite. It is the whole
 * function: replay the buffered cookie through `Response.cookie()`.
 */
const applyBufferedCookie = (response: any, cookie: BufferedCookie) => {
  response.cookie(cookie.name, cookie.value, cookie.options ?? {});
};

function moduleLoader(modules: Record<string, unknown>): PageModuleLoader {
  return async (moduleId: string) => {
    const module = modules[moduleId];

    if (!module) throw new Error(`fake loader: nothing registered for "${moduleId}"`);

    return module;
  };
}

/**
 * Run ONE document request end to end and hand back the reply the emit wrote
 * to. `url` doubles as the registered route path — the pipeline matches by
 * path, and there are no params in play here.
 */
async function renderToWire(page: unknown, url = "/account/settings", layout?: unknown) {
  const http = createCoreHttp({ url });

  const handler = createPageRouteHandler({
    path: url,
    name: "wire.page",
    appFile: APP_FILE,
    pageFile: PAGE_FILE,
    layoutFile: layout === undefined ? undefined : LAYOUT_FILE,
    loadModule: moduleLoader({
      [APP_FILE]: App,
      [PAGE_FILE]: page,
      ...(layout === undefined ? {} : { [LAYOUT_FILE]: layout }),
    }),
    applyBufferedCookie: applyBufferedCookie as never,
  });

  await handler({ request: http.request, response: http.response } as unknown as HttpContext);

  return http.reply;
}

/** Every `Set-Cookie` the reply was handed, in application order, by name. */
const cookieNames = (reply: { cookies: { name: string }[] }) =>
  reply.cookies.map(cookie => cookie.name);

describe("loader redirect on a DOCUMENT render reaches the wire", () => {
  it("writes Location and 302 to the reply, not just to the bundle", async () => {
    const guardedPage = {
      loader: async ({ response }: any) => response.redirect("/login?returnTo=/account/settings"),
      default: () => null,
    };

    const reply = await renderToWire(guardedPage);

    // THE ASSERTION THIS FILE EXISTS FOR. Without it a browser receives
    // `302` + an empty text/html body and stays exactly where it was.
    expect(reply.appliedHeaders.location).toBe("/login?returnTo=/account/settings");
    expect(reply.statusCode).toBe(302);

    // …and the response really was flushed, with no document to speak of.
    expect(reply.sent).toBe(true);
    expect(reply.payloads).toHaveLength(1);
    expect(reply.payloads[0] ?? "").toBe("");
  });

  it("carries a redirecting loader's own committed cookie to the wire alongside Location", async () => {
    // The signalling level's buffer commits (execute-page-request.ts:676) —
    // the cookie and the Location have to survive the SAME emit, because a
    // guard that redirects usually also remembers where you were going.
    const guardedPage = {
      loader: async ({ response }: any) => {
        response.cookie("intended-url", "/account/settings");
        return response.redirect("/login");
      },
      default: () => null,
    };

    const reply = await renderToWire(guardedPage);

    expect(reply.appliedHeaders.location).toBe("/login");

    // WAS `["intended-url", "intended-url"]`. The duplicate was real and was
    // asserted on purpose so that removing it would be a visible edit:
    // `commitBuffers` mirrored every committed cookie onto the live response
    // AND the handler replayed the same list through `applyBufferedCookie`,
    // so fastify was handed two identical `setCookie` calls. The mirror's
    // cookie half is gone (execute-page-request.ts, `commitBuffers`); the
    // handler's replay is now the single application site. See the
    // "EXACTLY ONCE" describe below for the per-path proof.
    expect(cookieNames(reply)).toEqual(["intended-url"]);
  });

  it("permanentRedirect writes Location and 301 — same shape, same path", async () => {
    // `permanentRedirect` returns the identical `kind: "redirect"` signal at a
    // different status (`buffered-response.ts:98-101`). It is deliberately NOT
    // special-cased anywhere; if it ever needs to be, this spec is where that
    // divergence becomes visible.
    const movedPage = {
      loader: async ({ response }: any) => response.permanentRedirect("/new-home"),
      default: () => null,
    };

    const reply = await renderToWire(movedPage);

    expect(reply.appliedHeaders.location).toBe("/new-home");
    expect(reply.statusCode).toBe(301);
  });

  it("notFound writes 404 and NO Location — the negative control", async () => {
    // The other short-circuit kind shares the signal shape but has no URL.
    // Without this, a fix that blindly wrote `Location` for every
    // short-circuit would pass the three specs above.
    const missingPage = {
      loader: async ({ response }: any) => response.notFound(),
      default: () => null,
    };

    const reply = await renderToWire(missingPage);

    expect(reply.statusCode).toBe(404);
    expect(reply.appliedHeaders.location).toBeUndefined();
  });

  it("a page that renders normally emits no Location", async () => {
    const plainPage = {
      loader: async () => ({ ok: true }),
      default: () => null,
    };

    const reply = await renderToWire(plainPage);

    expect(reply.statusCode).toBe(200);
    expect(reply.appliedHeaders.location).toBeUndefined();
  });
});

/**
 * A committed cookie reaches the wire EXACTLY ONCE — on every path that can
 * commit one, not just the happy one.
 *
 * WHY THE PATHS ARE ENUMERATED. De-duplicating meant deleting one of two
 * writers, and "delete the redundant one" is only safe if you know no path
 * depends on it alone. The two writers were:
 *
 *   1. the commit stage's live mirror — `commitBuffers` looping
 *      `realResponse.cookie(...)` at stage 7, BEFORE render;
 *   2. the handler's replay — `applyBufferedCookie` over `rendered.cookies`
 *      at stage 10a, after render, at the same site that applies the headers
 *      and the final status.
 *
 * (2) is authoritative and (1) was deleted, for three reasons that this file
 * is the evidence for:
 *
 *   - (2) is a SUPERSET. `finishRender` adds the framework's own answers to
 *     the returned maps after the commit ran (`cache-control: private`,
 *     render-page.ts) and picks the final status only after the render can no
 *     longer change it. The mirror carries the loaders' writes and nothing
 *     else, so (2) has to exist regardless; (1) does not.
 *   - (1) fires BEFORE stage 9. It commits an answer the render can still
 *     overturn — which is already true of its status write, where
 *     `finishRender` recomputes and the handler re-applies.
 *   - (1) had no consumer. `createPageRouteHandler` is the only production
 *     emit path, and it always runs (2).
 *
 * The cases below are the "and no path depended on (1) alone" half: each one
 * commits a cookie down a different exit and reads it back off the reply.
 */
describe("a committed cookie reaches the wire EXACTLY ONCE, on every exit", () => {
  it("HAPPY PATH — page loader cookie, one Set-Cookie, document flushed", async () => {
    const cookiePage = {
      loader: async ({ response }: any) => {
        response.cookie("session", "abc", { httpOnly: true });
        return { ok: true };
      },
      default: () => null,
    };

    const reply = await renderToWire(cookiePage);

    expect(cookieNames(reply)).toEqual(["session"]);
    // Attribute-faithful, not just present: a Set-Cookie that lost `httpOnly`
    // on the way to the wire is a security defect, not a cosmetic one.
    expect(reply.cookies[0].options).toMatchObject({ httpOnly: true });
    expect(reply.statusCode).toBe(200);
    expect(reply.sent).toBe(true);
  });

  it("SHORT-CIRCUIT · loader redirect (page level) — cookie survives the 302", async () => {
    const guardedPage = {
      loader: async ({ response }: any) => {
        response.cookie("intended-url", "/account/settings");
        return response.redirect("/login");
      },
      default: () => null,
    };

    const reply = await renderToWire(guardedPage);

    expect(cookieNames(reply)).toEqual(["intended-url"]);
    expect(reply.statusCode).toBe(302);
    expect(reply.appliedHeaders.location).toBe("/login");
  });

  it("SHORT-CIRCUIT · loader redirect (LAYOUT level) — the signalling level's own buffer still reaches the wire", async () => {
    // The case `pipeline-loaders.spec.ts` covers at the bundle: a layout
    // redirect commits its OWN buffer and discards the page's
    // (`buffers.slice(0, index + 1)`). Read at the wire here, because the
    // bundle cannot see whether the emit drained that buffer — which is the
    // exact blind spot that hid the missing `Location`.
    const accountLayout = {
      loader: async ({ response }: any) => {
        response.cookie("intended-url", "/account/settings");
        return response.redirect("/login");
      },
      default: ({ children }: any) => children,
    };
    const neverReachedPage = {
      loader: async ({ response }: any) => {
        response.cookie("page-cookie", "discarded");
        return { secret: "must not surface" };
      },
      default: () => null,
    };

    const reply = await renderToWire(neverReachedPage, "/account/settings", accountLayout);

    // The layout's cookie arrived once; the discarded level's never arrived.
    expect(cookieNames(reply)).toEqual(["intended-url"]);
    expect(reply.statusCode).toBe(302);
    expect(reply.appliedHeaders.location).toBe("/login");
  });

  it("SHORT-CIRCUIT · loader notFound — cookie survives the 404, and no Location", async () => {
    const missingPage = {
      loader: async ({ response }: any) => {
        response.cookie("last-seen", "/account/settings");
        return response.notFound();
      },
      default: () => null,
    };

    const reply = await renderToWire(missingPage);

    expect(cookieNames(reply)).toEqual(["last-seen"]);
    expect(reply.statusCode).toBe(404);
    expect(reply.appliedHeaders.location).toBeUndefined();
  });

  it("SHORT-CIRCUIT · middleware redirect — the cookie rides the LIVE response, not the buffer", async () => {
    // Deliberately a different mechanism, and the reason this case is here.
    // Middleware runs at stage 3 with the REAL response (there are no buffers
    // yet), so its cookie is written through `Response.cookie()` on the spot
    // and `bundle.commit` is never even built — neither of the two writers
    // under discussion is involved. Removing the mirror must not disturb it,
    // and this is what says so.
    const guardedPage = {
      middleware: [
        ({ response }: any) => {
          response.cookie("mw-flash", "denied");
          return response.redirect("/login");
        },
      ],
      loader: async () => ({ never: true }),
      default: () => null,
    };

    const reply = await renderToWire(guardedPage);

    expect(cookieNames(reply)).toEqual(["mw-flash"]);
    expect(reply.statusCode).toBe(302);
    expect(reply.appliedHeaders.location).toBe("/login");
  });

  it("ERROR PATH · a page loader throw still emits the rootward levels' committed cookies once", async () => {
    // The third commit call site (`buffers.slice(0, firstError.index)`): the
    // throwing level's buffer is discarded, everything rootward of it
    // commits. A boundary render is still a full emit, so the cookie a layout
    // set before the page blew up has to arrive — exactly once.
    const accountLayout = {
      loader: async ({ response }: any) => {
        response.cookie("layout-cookie", "kept");
        return { nav: [] };
      },
      default: ({ children }: any) => children,
    };
    const explodingPage = {
      loader: async ({ response }: any) => {
        response.cookie("page-cookie", "discarded-with-its-buffer");
        throw new Error("page loader exploded");
      },
      default: () => null,
    };

    const reply = await renderToWire(explodingPage, "/account/settings", accountLayout);

    expect(cookieNames(reply)).toEqual(["layout-cookie"]);
    expect(reply.sent).toBe(true);
  });
});

describe("the reply shim records terminal calls instead of swallowing them", () => {
  /**
   * `createReplyShim.redirect()` was `() => shim` — a no-op. That is the
   * reason the defect above shipped: the only harness surface that could have
   * reported "the socket was written to" reported nothing at all
   * (design/loader-endpoint-seam-2026-08-23.md §7). This spec keeps it honest.
   */
  it("redirect() records the call, the Location, the status and the sent state", () => {
    const reply = createReplyShim();

    expect(reply.sent).toBe(false);

    reply.redirect("/login");

    expect(reply.redirects).toEqual([{ url: "/login", statusCode: 302 }]);
    expect(reply.appliedHeaders.location).toBe("/login");
    expect(reply.statusCode).toBe(302);
    expect(reply.sent).toBe(true);
  });

  it("send() marks the reply sent, so core's double-send guard can fire", () => {
    const reply = createReplyShim();

    reply.send("body");

    expect(reply.payloads).toEqual(["body"]);
    expect(reply.sent).toBe(true);
  });
});
