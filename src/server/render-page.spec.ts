import { Response, type Request } from "@warlock.js/core";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PAYLOAD_SCRIPT_ID } from "../components/document-context";
import { useLocale } from "../localization";

const { resolvePageMetadata } = vi.hoisted(() => ({
  resolvePageMetadata: vi.fn(() => ({ metadata: {} })),
}));

vi.mock("./resolve-page-metadata", async () => {
  const actual = await vi.importActual<
    typeof import("./resolve-page-metadata")
  >("./resolve-page-metadata");
  return { ...actual, resolvePageMetadata };
});
vi.mock("../shared", () => ({
  enterSharedScope: vi.fn(),
  sealShared: vi.fn(async () => Object.freeze({})),
}));

import {
  connectPageContext,
  type PageRouteEntry,
} from "./execute-page-request";
import { isNonHydrating } from "./page-render-bundle";
import { renderPage, renderPageFailure } from "./render-page";
import type { ErrorPageModule } from "./error-page";

beforeEach(() => {
  resolvePageMetadata.mockClear();
  connectPageContext({
    buildStore: (payload) => payload as never,
    getStore: () => undefined,
    run: async (_store, callback) => callback(),
  });
});

/**
 * `renderPage.request`/`.response` mirror what `capturingCreateHttp` needs:
 * `documentSlotsFrom` reads `.nonce`/`.locale`, and `finishRender` reads
 * `.getHeaders`/`.header`/`.statusCode` — the same surface core's real
 * `Response` implements, used here directly (as other server specs do)
 * rather than re-declaring it.
 */
function createHttp(locale = "en") {
  const response = new Response();
  const request = { nonce: undefined, locale } as unknown as Request;

  return { request, response };
}

describe("request-bound locale provider", () => {
  it("keeps concurrent SSR documents and their hydration payloads on their own locale", async () => {
    let started = 0;
    let release!: () => void;
    let confirmBothStarted!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bothStarted = new Promise<void>((resolve) => {
      confirmBothStarted = resolve;
    });
    const entry: PageRouteEntry = {
      path: "/locale",
      name: "locale",
      triple: {
        app: {},
        layout: {},
        page: {
          loader: async () => {
            started += 1;
            if (started === 2) confirmBothStarted();
            await held;
          },
          default: () => createElement("main", { lang: useLocale() }, useLocale()),
        },
      },
    };

    const renderLocale = async (locale: string) => {
      const { request, response } = createHttp(locale);
      const rendered = await renderPage("locale", {
        routes: [entry],
        createHttp: () => ({ request, response }),
      });

      if (rendered instanceof Response) throw new Error("unexpected terminal Response");

      return rendered.html;
    };

    const englishRender = renderLocale("en");
    const arabicRender = renderLocale("ar");

    await bothStarted;
    expect(started).toBe(2);
    release();

    const [english, arabic] = await Promise.all([englishRender, arabicRender]);

    expect(english).toContain('<main lang="en">en</main>');
    expect(english).toContain('"locale":"en"');
    expect(arabic).toContain('<main lang="ar">ar</main>');
    expect(arabic).toContain('"locale":"ar"');
  });
});

function throwingPageEntry(): PageRouteEntry {
  return {
    path: "/boom",
    name: "boom",
    triple: {
      app: {},
      layout: {},
      page: {
        default: () => {
          throw new Error("page render exploded");
        },
      },
    },
  };
}

function fakeErrorPageModule(): ErrorPageModule {
  return {
    default: () => createElement("main", {}, "Sorry about that."),
  };
}

describe("renderPageFailure — pre-triple fallback", () => {
  it("marks the bundle non-hydrating and emits neither the __WARLOCK_DATA__ payload nor its script", async () => {
    const { request, response } = createHttp();

    const rendered = await renderPageFailure({
      name: "boom",
      path: "/boom",
      request,
      response,
      thrown: new Error("module load failed"),
      loadErrorPage: async () => fakeErrorPageModule(),
    });

    expect(isNonHydrating(rendered.bundle)).toBe(true);
    expect(rendered.html).not.toContain(PAYLOAD_SCRIPT_ID);
  });

  it("stays non-hydrating even when it falls all the way back to FrameworkRootBoundary (no app error page configured)", async () => {
    const { request, response } = createHttp();

    const rendered = await renderPageFailure({
      name: "boom",
      path: "/boom",
      request,
      response,
      thrown: new Error("module load failed"),
    });

    expect(isNonHydrating(rendered.bundle)).toBe(true);
    expect(rendered.html).not.toContain(PAYLOAD_SCRIPT_ID);
  });
});

describe("finishRender — normal app error page path", () => {
  it("keeps a normal app error page hydratable: bundle unmarked, __WARLOCK_DATA__ payload present", async () => {
    const entry = throwingPageEntry();
    const { request, response } = createHttp();

    const rendered = await renderPage("boom", {
      routes: [entry],
      createHttp: () => ({ request, response }),
      loadErrorPage: async () => fakeErrorPageModule(),
    });

    if (rendered instanceof Response)
      throw new Error("unexpected terminal Response");

    expect(isNonHydrating(rendered.bundle)).toBe(false);
    expect(rendered.html).toContain(PAYLOAD_SCRIPT_ID);
    expect(rendered.bundle?.errorPage).toEqual({
      error: {
        name: expect.any(String),
        message: expect.any(String),
        stack: expect.any(String),
      },
      status: 500,
    });
  });
});

describe("finishRender ordinary page props", () => {
  it("passes nested dynamic-route params only to the page, not its layout or root", async () => {
    type WrapperProps = {
      data: unknown;
      shared: unknown;
      children?: ReactNode;
    };
    type PageProps = {
      data: unknown;
      shared: unknown;
      params: Readonly<Record<string, string>>;
    };
    let appProps: WrapperProps | undefined;
    let layoutProps: WrapperProps | undefined;
    let pageProps: PageProps | undefined;
    const { request, response } = createHttp();
    const entry: PageRouteEntry = {
      path: "/catalog/:category/products/:productId",
      name: "catalog.products.details",
      triple: {
        app: {
          default: (props: WrapperProps) => {
            appProps = props;
            return props.children;
          },
        },
        layout: {
          default: (props: WrapperProps) => {
            layoutProps = props;
            return props.children;
          },
        },
        page: {
          default: (props: PageProps) => {
            pageProps = props;
            return null;
          },
        },
      },
    };

    await renderPage(entry.name, {
      params: { category: "books", productId: "42" },
      routes: [entry],
      createHttp: () => ({ request, response }),
    });

    expect(pageProps?.params).toEqual({ category: "books", productId: "42" });
    expect(appProps).not.toHaveProperty("params");
    expect(layoutProps).not.toHaveProperty("params");
  });
});
