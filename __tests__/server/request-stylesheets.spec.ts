import { createElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Response } from "@warlock.js/core";
import { createCoreHttp, requestContext } from "../../src/server/__fixtures__/core-http";
import * as App from "./fixtures/root";
import {
  connectPageContext,
  renderPageRequest,
  type PageContextRunner,
  type PageRouteEntry,
  type PageTripleModule,
} from "../../src/server/index";
import { connectSharedStore, type SharedStoreResolver } from "../../src/shared";
import { linkStylesheetsFor } from "../../src/index";

/**
 * Per-request stylesheets: middleware picks a theme for THIS request and
 * declares the theme module's source; the document head must link that
 * module's CSS — and only for the request that declared it.
 */

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

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const THEME_SOURCES: Record<string, string> = {
  alpha: "src/web/themes/alpha/alpha-theme.tsx",
  beta: "src/web/themes/beta/beta-theme.tsx",
};

const themedPage = {
  middleware: [
    async ({ request }: { request: { input(key: string): unknown } }) => {
      const theme = request.input("theme");

      if (typeof theme === "string") linkStylesheetsFor(request, THEME_SOURCES[theme]!);
    },
  ],
  default: () => createElement("main", null, "themed"),
};

const entry: PageRouteEntry = {
  path: "/store",
  name: "store",
  triple: {
    app: App as unknown as PageTripleModule,
    layout: {} as PageTripleModule,
    page: themedPage as unknown as PageTripleModule,
  },
};

async function renderStore(query: Record<string, string>) {
  const http = createCoreHttp({ url: "/store", query });
  const resolved: Array<readonly string[]> = [];

  const rendered = await renderPageRequest("/store", {
    routes: [entry],
    createHttp: () => ({ request: http.request, response: http.response }),
    stylesheetUrls: ["/assets/root.css"],
    resolveRequestStylesheetUrls: (sources) => {
      resolved.push(sources);
      return sources.map((source) => `/assets/${source.split("/").pop()!.replace(".tsx", ".css")}`);
    },
  });

  if (rendered instanceof Response) throw new Error("unexpected terminal Response");

  return { html: rendered.html, resolved };
}

describe("per-request stylesheets in the SSR head", () => {
  it("links the declared theme module's css after the handler's static chain", async () => {
    const { html, resolved } = await renderStore({ theme: "alpha" });

    expect(resolved).toEqual([["src/web/themes/alpha/alpha-theme.tsx"]]);
    expect(html).toContain(
      '<link rel="stylesheet" href="/assets/root.css"/><link rel="stylesheet" href="/assets/alpha-theme.css"/>',
    );
    expect(html).not.toContain("beta-theme.css");
  });

  it("gives a concurrent request for another theme only its own theme's css", async () => {
    const [alpha, beta] = await Promise.all([
      renderStore({ theme: "alpha" }),
      renderStore({ theme: "beta" }),
    ]);

    expect(alpha.html).toContain("/assets/alpha-theme.css");
    expect(alpha.html).not.toContain("/assets/beta-theme.css");
    expect(beta.html).toContain("/assets/beta-theme.css");
    expect(beta.html).not.toContain("/assets/alpha-theme.css");
  });

  it("links only the static chain when nothing was declared, without calling the resolver", async () => {
    const { html, resolved } = await renderStore({});

    expect(resolved).toEqual([]);
    expect(html).toContain('<link rel="stylesheet" href="/assets/root.css"/>');
    expect(html).not.toContain("-theme.css");
  });
});
