import { describe, expect, it, vi } from "vitest";
import type { HttpContext } from "@warlock.js/core";
import type { PageRouteHandler } from "./create-page-route-handler";
import {
  acceptsHtmlExplicitly,
  classifyUnmatchedRequest,
  createNotFoundRouteHandler,
  frameworkDefaultNotFoundDocument,
  isNotFoundPageFile,
  NOT_FOUND_PAGE_FILENAME,
} from "./not-found-page";

/**
 * THE ACCEPTANCE CRITERION OF THIS FEATURE, at the unit level: a caller that did
 * not explicitly ask for a document must not receive one. Everything else here
 * is in service of that.
 */

/** What a browser puts in `Accept` for an address-bar navigation. */
const BROWSER_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

/** What a bare `fetch()` puts in `Accept` — the case that must NOT get HTML. */
const FETCH_ACCEPT = "*/*";

function classify(method: string, accept: string | undefined) {
  return classifyUnmatchedRequest({ method, accept });
}

describe("the not-found page's file identity", () => {
  it("recognises 404.page.tsx by basename, under either separator", () => {
    expect(isNotFoundPageFile("src/app/main/web/404.page.tsx")).toBe(true);
    expect(isNotFoundPageFile("D:\\app\\src\\web\\404.page.tsx")).toBe(true);
    expect(isNotFoundPageFile(NOT_FOUND_PAGE_FILENAME)).toBe(true);
  });

  it("is the filename and nothing near it — a page is not the not-found page by resemblance", () => {
    expect(isNotFoundPageFile("src/web/not-found.page.tsx")).toBe(false);
    expect(isNotFoundPageFile("src/web/404.tsx")).toBe(false);
    expect(isNotFoundPageFile("src/web/my-404.page.tsx")).toBe(false);
    // A DIRECTORY named 404 does not make the page inside it the not-found page.
    expect(isNotFoundPageFile("src/web/404.page.tsx/home.page.tsx")).toBe(false);
  });
});

describe("acceptsHtmlExplicitly — the discriminator, in isolation", () => {
  it("accepts the header a browser sends for an address-bar navigation", () => {
    expect(acceptsHtmlExplicitly(BROWSER_ACCEPT)).toBe(true);
    expect(acceptsHtmlExplicitly("text/html")).toBe(true);
    expect(acceptsHtmlExplicitly("application/json, text/html")).toBe(true);
    expect(acceptsHtmlExplicitly(" TEXT/HTML ;q=0.9 ")).toBe(true);
  });

  it("REFUSES every wildcard — this is the whole rule", () => {
    // `*/*` is what `fetch()` sends. It is the absence of a preference, not a
    // request for a document, and reading it as one is the defect.
    expect(acceptsHtmlExplicitly(FETCH_ACCEPT)).toBe(false);
    expect(acceptsHtmlExplicitly("*/*;q=0.8")).toBe(false);
    // `text/*` names a family, not the type.
    expect(acceptsHtmlExplicitly("text/*")).toBe(false);
  });

  it("refuses a missing, empty or unrelated header", () => {
    expect(acceptsHtmlExplicitly(undefined)).toBe(false);
    expect(acceptsHtmlExplicitly("")).toBe(false);
    expect(acceptsHtmlExplicitly("application/json")).toBe(false);
  });

  it("does not match text/html as a SUBSTRING of another type", () => {
    expect(acceptsHtmlExplicitly("application/text/html")).toBe(false);
    expect(acceptsHtmlExplicitly("text/html-fragment")).toBe(false);
  });

  it("honours q=0 as the refusal the header says it is", () => {
    expect(acceptsHtmlExplicitly("text/html;q=0, application/json")).toBe(false);
    expect(acceptsHtmlExplicitly("text/html;q=0.0")).toBe(false);
    // A second, non-zero entry still opens the page path.
    expect(acceptsHtmlExplicitly("text/html;q=0, text/html;q=1")).toBe(true);
  });
});

describe("THE RULE — a caller that did not ask for a document never gets one", () => {
  it("answers a browser navigation with the page", () => {
    expect(classify("GET", BROWSER_ACCEPT)).toBe("page");
    expect(classify("HEAD", BROWSER_ACCEPT)).toBe("page");
    expect(classify("get", BROWSER_ACCEPT)).toBe("page");
  });

  it("answers a bare fetch() with API, whatever the path looks like", () => {
    // Pages and API share ONE namespace, so the path carries no signal at all —
    // `/api/uzers` and `/prodcts` are the same question here.
    expect(classify("GET", FETCH_ACCEPT)).toBe("api");
    expect(classify("GET", undefined)).toBe("api");
    expect(classify("GET", "application/json")).toBe("api");
  });

  it("treats every verb but GET and HEAD as API — pages are only ever installed with router.get", () => {
    expect(classify("POST", BROWSER_ACCEPT)).toBe("api");
    expect(classify("PUT", BROWSER_ACCEPT)).toBe("api");
    expect(classify("PATCH", BROWSER_ACCEPT)).toBe("api");
    expect(classify("DELETE", BROWSER_ACCEPT)).toBe("api");
  });
});

type SentResponse = { body: unknown; status: number | undefined; kind: "json" | "html" };

function fakeContext(method: string, path: string, accept: string | undefined) {
  const sent: SentResponse[] = [];

  const context = {
    request: { method, path, header: (name: string) => (name === "accept" ? accept : undefined) },
    response: {
      send: vi.fn(async (body: unknown, status?: number) => {
        sent.push({ body, status, kind: "json" });
      }),
      html: vi.fn(async (body: string, status?: number) => {
        sent.push({ body, status, kind: "html" });
      }),
    },
  } as unknown as HttpContext;

  return { context, sent };
}

describe("createNotFoundRouteHandler — the three answers", () => {
  it("declines an API request with JSON 404 and never reaches the page, even when a page exists", async () => {
    const renderPage = vi.fn(async () => undefined) as unknown as PageRouteHandler;
    const handler = createNotFoundRouteHandler({ renderPage });
    const { context, sent } = fakeContext("GET", "/api/uzers", FETCH_ACCEPT);

    await handler(context);

    expect(renderPage).not.toHaveBeenCalled();
    expect(sent).toEqual([
      {
        kind: "json",
        status: 404,
        body: { error: "Route not found", path: "/api/uzers", method: "GET" },
      },
    ]);
    // No HTML anywhere in the answer — the whole point.
    expect(JSON.stringify(sent)).not.toContain("<");
  });

  it("renders the application's page for a page request", async () => {
    const renderPage = vi.fn(async () => undefined) as unknown as PageRouteHandler;
    const handler = createNotFoundRouteHandler({ renderPage });
    const { context, sent } = fakeContext("GET", "/prodcts", BROWSER_ACCEPT);

    await handler(context);

    expect(renderPage).toHaveBeenCalledTimes(1);
    // The page handler owns the response from here; nothing was written first.
    expect(sent).toEqual([]);
  });

  it("falls back to the framework default — a real document, with a real 404 status", async () => {
    const handler = createNotFoundRouteHandler({});
    const { context, sent } = fakeContext("GET", "/prodcts", BROWSER_ACCEPT);

    await handler(context);

    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("html");
    expect(sent[0].status).toBe(404);
    expect(sent[0].body).toBe(frameworkDefaultNotFoundDocument());
    expect(String(sent[0].body)).toContain(NOT_FOUND_PAGE_FILENAME);
  });

  it("still answers a fetch() with JSON when the application ships no 404 page", async () => {
    const handler = createNotFoundRouteHandler({});
    const { context, sent } = fakeContext("GET", "/api/uzers", FETCH_ACCEPT);

    await handler(context);

    expect(sent[0].kind).toBe("json");
    expect(sent[0].status).toBe(404);
  });

  it("renders the page for a browser navigation to a typo'd API URL, and says so", async () => {
    // The tradeoff this rule accepts, stated as a test so it cannot change
    // silently: the header is a fact about the CLIENT, and a browser asking for
    // `/api/uzers` asks for a document like any other navigation. The status is
    // still 404, which is the part machines read.
    const handler = createNotFoundRouteHandler({});
    const { context, sent } = fakeContext("GET", "/api/uzers", BROWSER_ACCEPT);

    await handler(context);

    expect(sent[0].kind).toBe("html");
    expect(sent[0].status).toBe(404);
  });
});

describe("the framework default document", () => {
  it("is a complete document that names the file needed to replace it", () => {
    const html = frameworkDefaultNotFoundDocument();

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
    expect(html).toContain("404");
    expect(html).toContain("404.page.tsx");
    // Nothing that can fail: no stylesheet link, no hydration script.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<link");
  });
});
