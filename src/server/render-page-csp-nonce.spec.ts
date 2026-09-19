/**
 * Card 3926afb3 — React's own inline scripts (the `$RC`/`$RS` boundary-reveal
 * scripts Fizz streams to swap a completed Suspense boundary's placeholder
 * into place) were emitted with NO `nonce` attribute at all:
 * `renderElementToPipeableStream` (`render-page.ts`) called
 * `renderToPipeableStream` with an `options` object that set `onShellError`/
 * `onError`/`onShellReady`/`onAllReady`/`progressiveChunkSize` but never
 * `nonce` — the one option React 19 reads to stamp its OWN inline scripts.
 * Under a strict `script-src 'nonce-...'` CSP (no `'unsafe-inline'`), the
 * browser blocks `$RC` and a deferred Suspense boundary's fallback never
 * gets swapped for the real content.
 *
 * This is the ONE call site `renderToPipeableStream` is invoked from
 * (`render-page.ts`'s `renderElementToPipeableStream`) — every document that
 * can stream (the ordinary flush-early path, and the crawler/`waitForAll`
 * path) and every error-document render funnels through it, so passing
 * `documentSlots.nonce` there fixes all of them at once.
 *
 * Red-first: dropping the `nonce` argument from the
 * `renderToPipeableStream(element, options)` call in `render-page.ts` makes
 * the first spec below fail — React's `$RC` script comes back with no
 * `nonce="..."` attribute.
 */
import { createElement, Suspense, use } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Response } from "@warlock.js/core";
import { createCoreHttp, requestContext } from "./__fixtures__/core-http";
import * as App from "../../__tests__/server/fixtures/root";
import * as layout from "../../__tests__/server/fixtures/layout";
import { defer } from "../loaders/defer";
import {
  connectPageContext,
  renderPageRequest,
  type PageContextRunner,
  type PageRouteEntry,
  type PageTripleModule,
} from "./index";
import { connectSharedStore, type SharedStoreResolver } from "../shared";

let previousRunner: PageContextRunner | undefined;
let previousResolver: SharedStoreResolver | undefined;

beforeAll(() => {
  previousRunner = connectPageContext(requestContext as unknown as PageContextRunner);
  previousResolver = connectSharedStore(() => requestContext.getStore() as never);
});

afterAll(() => {
  connectPageContext(previousRunner);
  connectSharedStore(previousResolver);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function pageEntry(path: string, page: Record<string, unknown>): PageRouteEntry {
  return {
    path,
    name: path.replace("/", ""),
    triple: {
      app: App as unknown as PageTripleModule,
      layout: layout as unknown as PageTripleModule,
      page: page as unknown as PageTripleModule,
    },
  };
}

function Reviews({ reviews }: { reviews: Promise<{ rating: number }> }) {
  const value = use(reviews);
  return createElement("span", null, `rating:${value.rating}`);
}

/** A page with a real Suspense boundary around a `defer()`-ed value. */
function deferredPage(reviews: Promise<{ rating: number }>) {
  return {
    loader: async () => defer({ greeting: "hi", reviews }),
    default: ({ data }: { data: { greeting: string; reviews: Promise<{ rating: number }> } }) =>
      createElement(
        "main",
        null,
        data.greeting,
        createElement(
          Suspense,
          { fallback: "LOADING" },
          createElement(Reviews, { reviews: data.reviews }),
        ),
      ),
  };
}

/**
 * Renders `page` through the real pipeline and returns the FULL streamed
 * wire HTML (every chunk React/`defer-emission.ts` ever write to the raw
 * reply) plus the request's own CSP nonce — the same value
 * `documentSlotsFrom` reads off `request.nonce` inside `render-page.ts`.
 */
async function streamWireHtml(
  page: Record<string, unknown>,
  options: { crawler?: boolean; onFirstChunk?: () => void } = {},
): Promise<{ html: string; nonce: string }> {
  const { onFirstChunk, ...renderOptions } = options;
  const entry = pageEntry("/dashboard", page);
  const http = createCoreHttp({ url: "/dashboard" });
  // `request.nonce` is a lazy getter that generates and caches a fresh value
  // on first read (core/src/http/request.ts) — reading it here up front is
  // exactly what a CSP-enabled deployment's header middleware would do
  // earlier in the request lifecycle, and guarantees this is the SAME nonce
  // `documentSlotsFrom` reads later.
  const nonce = http.request.nonce;
  const chunks: Buffer[] = [];
  http.reply.raw.on("data", (chunk: Buffer) => chunks.push(chunk));
  if (onFirstChunk) http.reply.raw.once("data", onFirstChunk);

  const rendered = await renderPageRequest("/dashboard", {
    routes: [entry],
    createHttp: () => ({ request: http.request, response: http.response }),
    ...renderOptions,
  });

  if (rendered instanceof Response) throw new Error("unexpected terminal Response");

  http.response.setContentType("text/html");
  http.response.setStatusCode(rendered.status);
  await http.response.streamReact(rendered.pipeableStream!);

  return { html: Buffer.concat(chunks).toString("utf8"), nonce };
}

describe("card 3926afb3 — React's own inline scripts carry the request's CSP nonce", () => {
  it("a Suspense boundary that resolves AFTER the shell emits React's own $RC reveal script, and every <script> tag on the wire carries the nonce", async () => {
    // Resolved only once the shell is on the wire, so the boundary is
    // revealed by a later chunk however slow the shell render is.
    let resolveReviews!: (value: { rating: number }) => void;
    const reviews = new Promise<{ rating: number }>((resolve) => {
      resolveReviews = resolve;
    });

    const { html, nonce } = await streamWireHtml(deferredPage(reviews), {
      onFirstChunk: () => setTimeout(() => resolveReviews({ rating: 5 }), 0),
    });

    // Proves the scenario actually reaches React's OWN boundary-reveal
    // script (Fizz's `$RC(...)`), not merely the framework's separate
    // `__WARLOCK_DEFER__` settlement chunk (`defer-emission.ts`, already
    // nonced before this fix).
    expect(html).toContain("$RC(");

    const scriptTags = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scriptTags.length).toBeGreaterThan(0);

    // Red control: remove the `nonce` argument from
    // `renderElementToPipeableStream`'s call to `renderToPipeableStream` in
    // render-page.ts — React's own `$RC` script comes back with no `nonce`
    // attribute at all and this assertion fails.
    for (const tag of scriptTags) {
      expect(tag).toContain(`nonce="${nonce}"`);
    }
  });

  it("the crawler/waitForAll path also renders through renderElementToPipeableStream with the request's nonce — every emitted script tag carries it", async () => {
    const reviews = Promise.resolve({ rating: 5 });

    const { html, nonce } = await streamWireHtml(deferredPage(reviews), { crawler: true });

    const scriptTags = html.match(/<script\b[^>]*>/g) ?? [];
    // The crawler document still carries the framework's own
    // `__WARLOCK_DEFER__` settlement chunk (`defer-emission.ts`) as a real
    // `<script>` tag even though every deferred value was already inlined
    // before render — see `finishRender`'s crawler-mode comment.
    expect(scriptTags.length).toBeGreaterThan(0);

    for (const tag of scriptTags) {
      expect(tag).toContain(`nonce="${nonce}"`);
    }
  });
});
