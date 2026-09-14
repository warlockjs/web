import { Response, type Request } from "@warlock.js/core";
import { v } from "@warlock.js/seal";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PAYLOAD_SCRIPT_ID } from "../components/document-context";
import { useLocale } from "../localization";
import type { ServerErrorPageProps } from "../props";

const { resolvePageMetadata } = vi.hoisted(() => ({
  resolvePageMetadata: vi.fn(() => ({ metadata: {} })),
}));

vi.mock("./resolve-page-metadata", async () => {
  const actual =
    await vi.importActual<typeof import("./resolve-page-metadata")>("./resolve-page-metadata");
  return { ...actual, resolvePageMetadata };
});
vi.mock("../shared", () => ({
  enterSharedScope: vi.fn(),
  sealShared: vi.fn(async () => Object.freeze({})),
}));

import { useQueryString } from "@warlock.js/web";
import { connectPageContext, type PageRouteEntry } from "./execute-page-request";
import { isNonHydrating } from "./page-render-bundle";
import { renderPageFailure, renderPageRequest } from "./render-page";
import type { ErrorPageModule } from "./error-page";
import type { PipelineStore } from "./execute-page-request.types";

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
      const rendered = await renderPageRequest("/locale", {
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

describe("useQueryString — package entry, SSR answer matches the request URL", () => {
  it("resolves the query key the request's own URL carries, from the pipeline's per-request store", async () => {
    // A real per-request ALS stand-in: `run` records the store WHILE its
    // callback is in flight and clears it after, so `getStore()` answers
    // truthfully for the one request currently rendering — the exact shape
    // `connectSharedStore`/`connectPageContext`'s own resolver relies on.
    let liveStore: PipelineStore | undefined;

    connectPageContext({
      buildStore: (payload) => payload as PipelineStore,
      getStore: () => liveStore,
      run: async (store, callback) => {
        liveStore = store;
        try {
          return await callback();
        } finally {
          liveStore = undefined;
        }
      },
    });

    const entry: PageRouteEntry = {
      path: "/search",
      name: "search",
      triple: {
        app: {},
        layout: {},
        page: {
          default: () => createElement("p", null, String(useQueryString("q") ?? "")),
        },
      },
    };

    const response = new Response();
    const request = {
      nonce: undefined,
      locale: "en",
      url: "/search?q=widgets",
    } as unknown as Request;

    const rendered = await renderPageRequest("/search?q=widgets", {
      routes: [entry],
      createHttp: () => ({ request, response }),
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    expect(rendered.html).toContain("<p>widgets</p>");
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

    const rendered = await renderPageRequest("/boom", {
      routes: [entry],
      createHttp: () => ({ request, response }),
      loadErrorPage: async () => fakeErrorPageModule(),
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

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

describe("finishRender — render-error floor (d47f5696)", () => {
  it("writes an SSR render throw to stderr, naming the route and passing the error", async () => {
    const entry = throwingPageEntry();
    const { request, response } = createHttp();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let calls: unknown[][];
    try {
      const rendered = await renderPageRequest("/boom", {
        routes: [entry],
        createHttp: () => ({ request, response }),
        loadErrorPage: async () => fakeErrorPageModule(),
      });
      if (rendered instanceof Response) throw new Error("unexpected terminal Response");
      calls = errorSpy.mock.calls.map((args) => [...args]);
    } finally {
      errorSpy.mockRestore();
    }

    // The thrown error object itself is passed (so its stack reaches the terminal).
    expect(
      calls.some((args) =>
        args.some((arg) => arg instanceof Error && arg.message === "page render exploded"),
      ),
    ).toBe(true);
    // And the route is named, so the developer knows WHERE it threw.
    expect(
      calls.some((args) => args.some((arg) => typeof arg === "string" && arg.includes("/boom"))),
    ).toBe(true);
  });
});

function createValidationHttp(
  locale: string,
  params: Record<string, string>,
  query: Record<string, string>,
) {
  let validatedData: Record<string, unknown> = {};
  const response = new Response();
  const request = {
    nonce: undefined,
    locale,
    params,
    query,
    setValidatedData(data: Record<string, unknown>) {
      validatedData = data;
    },
    validated() {
      return validatedData;
    },
  } as unknown as Request;

  return { request, response };
}

function failingValidationEntry(): PageRouteEntry {
  return {
    path: "/orders/:id",
    name: "orders.details",
    triple: {
      app: {},
      layout: {},
      page: {
        route: { path: "/orders/:id" },
        validation: {
          params: v.object({ id: v.int().coerce() }),
          query: v.object({ page: v.int().coerce() }),
        },
        default: () => createElement("main", {}, "page should not render"),
        loader: () => {
          throw new Error("loader must not run when validation fails");
        },
      },
    },
  };
}

function errorPageWithValidationDetails(): ErrorPageModule {
  return {
    default: (props: ServerErrorPageProps) => {
      const error = props.error as { errors?: { input: string }[] } | undefined;
      const paths = (error?.errors ?? []).map((issue) => issue.input).join(",");
      return createElement("main", {}, `status:${props.status} paths:${paths}`);
    },
  };
}

describe("finishRender — failed page validation on a full-document request (defect fix)", () => {
  it("renders the app error.page.tsx with status 400 and the validation errors, instead of an empty document", async () => {
    const { request, response } = createValidationHttp(
      "en",
      { id: "42" },
      { page: "not-a-number" },
    );

    const rendered = await renderPageRequest("/orders/42?page=not-a-number", {
      routes: [failingValidationEntry()],
      createHttp: () => ({ request, response }),
      loadErrorPage: async () => errorPageWithValidationDetails(),
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    expect(rendered.status).toBe(400);
    expect(rendered.html).not.toBe("");
    expect(rendered.html).toContain("status:400");
    expect(rendered.html).toContain("query.page");
  });

  it("keeps the DATA request contract unchanged: empty html, 400, and shortCircuit.stage === 'validation' with the errors, on the bundle", async () => {
    const { request, response } = createValidationHttp(
      "en",
      { id: "42" },
      { page: "not-a-number" },
    );

    const rendered = await renderPageRequest("/orders/42?page=not-a-number", {
      routes: [failingValidationEntry()],
      createHttp: () => ({ request, response }),
      loadErrorPage: async () => errorPageWithValidationDetails(),
      dataRequest: true,
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    expect(rendered.status).toBe(400);
    expect(rendered.html).toBe("");
    expect(rendered.bundle?.shortCircuit).toMatchObject({ stage: "validation", status: 400 });

    const errors = (rendered.bundle?.shortCircuit as { errors: { input: string }[] }).errors;
    expect(errors.some((issue) => issue.input.includes("page"))).toBe(true);
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

    await renderPageRequest("/catalog/books/products/42", {
      routes: [entry],
      createHttp: () => ({ request, response }),
    });

    expect(pageProps?.params).toEqual({ category: "books", productId: "42" });
    expect(appProps).not.toHaveProperty("params");
    expect(layoutProps).not.toHaveProperty("params");
  });
});
