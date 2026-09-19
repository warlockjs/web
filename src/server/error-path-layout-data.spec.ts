import { Response, type Request } from "@warlock.js/core";
import { v } from "@warlock.js/seal";
import { parse } from "devalue";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Head } from "../components/head";
import { Scripts } from "../components/scripts";
import { PAYLOAD_SCRIPT_ID } from "../components/document-context";
import type { ServerErrorPageProps } from "../props";

vi.mock("../shared", () => ({
  enterSharedScope: vi.fn(),
  sealShared: vi.fn(async () => Object.freeze({})),
}));

import { buildHydrationPayload } from "./build-hydration-payload";
import { connectPageContext, type PageRouteEntry } from "./execute-page-request";
import { renderPageRequest, type RenderedPage } from "./render-page";
import type { ErrorPageModule } from "./error-page";

/**
 * Card 5056fb56: a PAGE-level failure — a validation 400, or a page loader
 * throw — renders the application's `error.page.tsx` INSIDE the app and
 * layout chrome, so those components must receive the data their loaders
 * committed. Before the fix, validation ran ahead of every loader: the
 * layout rendered with `data === undefined`, a real layout reading
 * `data.user` crashed the error page itself, and the visitor got the bare
 * framework fallback instead of the app's error page.
 *
 * The fixture App and Layout read `data.appName` / `data.x` WITHOUT optional
 * chaining on purpose — an undefined `data` throws, exactly as the real
 * blog's `layout.tsx` did.
 */

beforeEach(() => {
  connectPageContext({
    buildStore: (payload) => payload as never,
    getStore: () => undefined,
    run: async (_store, callback) => callback(),
  });
});

const FRAMEWORK_FALLBACK = "Something went wrong.";
const APP_DATA = { appName: "Blog" };
const LAYOUT_DATA = { x: "layout-x" };

type WrapperProps<TData> = { data: TData; children?: ReactNode };

function App({ data, children }: WrapperProps<typeof APP_DATA>): ReactNode {
  return createElement(
    "html",
    {},
    createElement("head", {}, createElement(Head)),
    createElement(
      "body",
      {},
      createElement("div", { id: "app" }, `app:${data.appName}`, children),
      createElement(Scripts),
    ),
  );
}

function Layout({ data, children }: WrapperProps<typeof LAYOUT_DATA>): ReactNode {
  return createElement("section", { id: "layout" }, `layout:${data.x}`, children);
}

function createHttp(query: Record<string, string>) {
  let validatedData: Record<string, unknown> = {};
  const response = new Response();
  const request = {
    nonce: undefined,
    locale: "en",
    params: {},
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

function postsEntry(pageLoader: () => unknown): PageRouteEntry {
  return {
    path: "/posts",
    name: "posts.list",
    triple: {
      app: { loader: () => APP_DATA, default: App },
      layout: { loader: () => LAYOUT_DATA, default: Layout },
      page: {
        route: { path: "/posts" },
        validation: { query: v.object({ page: v.int().coerce() }) },
        loader: pageLoader,
        default: () => createElement("main", {}, "posts page"),
      },
    },
  };
}

function appErrorPage(): ErrorPageModule {
  return {
    default: (props: ServerErrorPageProps) =>
      createElement("main", { id: "app-error-page" }, `app error page status:${props.status}`),
  };
}

async function render(
  pageLoader: () => unknown,
  query: Record<string, string>,
  dataRequest = false,
): Promise<RenderedPage> {
  const { request, response } = createHttp(query);

  const rendered = await renderPageRequest(`/posts?${new URLSearchParams(query).toString()}`, {
    routes: [postsEntry(pageLoader)],
    createHttp: () => ({ request, response }),
    loadErrorPage: async () => appErrorPage(),
    dataRequest,
  });

  if (rendered instanceof Response) throw new Error("unexpected terminal Response");

  return rendered;
}

/** devalue-decodes the embedded `#__WARLOCK_DATA__` payload. */
function documentPayload(html: string): { appData: unknown; layoutData: unknown } {
  const match = new RegExp(`<script id="${PAYLOAD_SCRIPT_ID}"[^>]*>(.*?)<\\/script>`).exec(html);

  if (match === null) throw new Error("payload script not found in rendered HTML");

  return parse(match[1]!) as { appData: unknown; layoutData: unknown };
}

const invalidQuery = { page: "not-a-number" };
const validQuery = { page: "2" };
const unreachedLoader = () => {
  throw new Error("the page loader must not run when validation fails");
};
const throwingLoader = () => {
  throw new Error("page loader failed");
};

describe("page-level failure keeps the app and layout data (5056fb56)", () => {
  it("validation 400: the app error page renders inside the layout, which received its data", async () => {
    const rendered = await render(unreachedLoader, invalidQuery);

    expect(rendered.status).toBe(400);
    expect(rendered.html).toContain("app error page status:400");
    expect(rendered.html).toContain("layout:layout-x");
    expect(rendered.html).toContain("app:Blog");
    expect(rendered.html).not.toContain(FRAMEWORK_FALLBACK);
  });

  it("validation 400: the hydration payload carries the same app and layout data", async () => {
    const rendered = await render(unreachedLoader, invalidQuery);
    const payload = documentPayload(rendered.html);

    expect(payload.layoutData).toEqual(LAYOUT_DATA);
    expect(payload.appData).toEqual(APP_DATA);
  });

  it("page loader throw: the app error page renders inside the layout, which received its data", async () => {
    const rendered = await render(throwingLoader, validQuery);

    expect(rendered.status).toBe(500);
    expect(rendered.html).toContain("app error page status:500");
    expect(rendered.html).toContain("layout:layout-x");
    expect(rendered.html).toContain("app:Blog");
    expect(rendered.html).not.toContain(FRAMEWORK_FALLBACK);
  });

  it("page loader throw: the hydration payload carries the same app and layout data", async () => {
    const rendered = await render(throwingLoader, validQuery);
    const payload = documentPayload(rendered.html);

    expect(payload.layoutData).toEqual(LAYOUT_DATA);
    expect(payload.appData).toEqual(APP_DATA);
  });

  it("validation 400 data request: the contract is unchanged, and its payload carries the layout data", async () => {
    const rendered = await render(unreachedLoader, invalidQuery, true);

    expect(rendered.status).toBe(400);
    expect(rendered.html).toBe("");
    expect(rendered.bundle?.shortCircuit).toMatchObject({ stage: "validation", status: 400 });

    // The body `send-page-data-response.ts` answers a client navigation with.
    const payload = buildHydrationPayload(rendered.bundle!, "en");

    expect(payload.layoutData).toEqual(LAYOUT_DATA);
    expect(payload.appData).toEqual(APP_DATA);
  });
});
