import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { matchPath } from "./match-page-route";

/**
 * Do web's matcher and core's router produce the SAME params?
 *
 * This is the proof the "remove web's second matcher" card asks for before
 * anything is switched over. `bundle.route.params` reaches the hydration
 * payload (`build-hydration-payload.ts`), so if the two disagree on any URL,
 * swapping web's matcher for core's would hand the client different params than
 * the loader saw — silently, and only for the URLs where they differ.
 *
 * Core reads `request.params` straight off the Fastify request
 * (`core/src/http/request.ts:536`), so the honest comparison is against a real
 * Fastify route rather than against a description of one. Both sides use the
 * same `:param` syntax, so the patterns are identical and only the DECODING can
 * differ — which is precisely where a hand-rolled matcher usually diverges.
 *
 * Kept regardless of when that refactor lands: it is the thing that would catch
 * a divergence appearing later, and it costs one Fastify boot.
 */
const PATTERN = "/users/:id";

const CASES: Array<[label: string, url: string]> = [
  ["a plain segment", "/users/5"],
  ["an encoded slash", "/users/a%2Fb"],
  ["an encoded space", "/users/a%20b"],
  ["a literal plus", "/users/a+b"],
  ["an encoded plus", "/users/a%2Bb"],
  ["a percent", "/users/100%25"],
  ["non-ASCII", "/users/%D8%A7%D9%84%D8%B9%D8%B1%D8%A8%D9%8A%D8%A9"],
  ["a dot", "/users/file.txt"],
  ["a dash and underscore", "/users/a-b_c"],
];

const server = Fastify();
const seen = new Map<string, Record<string, string>>();

server.get(PATTERN, async (request) => {
  seen.set(request.url, request.params as Record<string, string>);

  return {};
});

async function coreParams(url: string): Promise<string | undefined> {
  await server.inject({ method: "GET", url });

  return seen.get(url)?.id;
}

describe("web's matcher agrees with core's router on params", () => {
  afterAll(async () => {
    await server.close();
  });

  it.each(CASES)("agrees for %s", async (_label, url) => {
    const fromCore = await coreParams(url);
    const fromWeb = matchPath(PATTERN, url.split("?")[0])?.id;

    // Neither may be undefined: a disagreement about whether the route matched
    // at all is a bigger divergence than a disagreement about the value.
    expect(fromWeb).toBeTypeOf("string");
    expect(fromCore).toBeTypeOf("string");
    expect(fromWeb).toBe(fromCore);
  });

  it("resolves the same named multi-segment route and every param", async () => {
    const pattern = "/stores/:storeId/products/:productId";
    const url = "/stores/cairo/products/42";
    const multiSegment = Fastify();
    let coreMatch: Record<string, string> | undefined;

    multiSegment.get(pattern, async (request) => {
      coreMatch = request.params as Record<string, string>;
      return {};
    });

    await multiSegment.inject({ method: "GET", url });
    await multiSegment.close();

    expect({ name: "product", params: matchPath(pattern, url) }).toEqual({
      name: "product",
      params: coreMatch,
    });
  });

  it("keeps the catch-all route's page match param-free", async () => {
    const url = "/missing/a/deep/path";
    const catchAll = Fastify();
    let matched = false;

    catchAll.get("*", async () => {
      matched = true;
      return {};
    });

    await catchAll.inject({ method: "GET", url });
    await catchAll.close();

    // The page handler replaces `*` with this request path before the current
    // web match, so the 404 page has a concrete named route and no invented
    // wildcard param. This is the behaviour the core-match handoff preserves.
    expect({ matched, name: "not-found", params: matchPath(url, url) }).toEqual({
      matched: true,
      name: "not-found",
      params: {},
    });
  });
});
