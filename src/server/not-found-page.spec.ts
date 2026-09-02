import { describe, expect, it, vi } from "vitest";
import { Response, type HttpContext } from "@warlock.js/core";
import type { PageRouteHandler } from "./create-page-route-handler";

vi.mock("./framework-default-not-found.css?url&inline", () => ({
  default: "data:text/css;base64,LmZha2Ute30=",
}));

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

function fakeContext(method: string, path: string, accept: string | undefined, locale?: string) {
  const sent: SentResponse[] = [];
  const headers = new Map<string, unknown>();

  const context = {
    request: {
      method,
      path,
      locale,
      header: (name: string) => (name === "accept" ? accept : undefined),
    },
    response: {
      header: vi.fn((name: string, value: unknown) => {
        headers.set(name.toLowerCase(), value);
      }),
      send: vi.fn(async (body: unknown, status?: number) => {
        sent.push({ body, status, kind: "json" });
      }),
      html: vi.fn(async (body: string, status?: number) => {
        sent.push({ body, status, kind: "html" });
      }),
    },
  } as unknown as HttpContext;

  return { context, sent, headers };
}

describe("createNotFoundRouteHandler — the three answers", () => {
  it("declines an API request with JSON 404 and never reaches the page, even when a page exists", async () => {
    const renderPage = vi.fn(async () => undefined) as unknown as PageRouteHandler;
    const handler = createNotFoundRouteHandler({ renderPage });
    const { context, sent, headers } = fakeContext("GET", "/api/uzers", FETCH_ACCEPT);

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
    expect(headers).toEqual(new Map([["cache-control", "no-store"]]));
  });

  it("renders the application's page for a page request", async () => {
    const renderPage = vi.fn(async () => undefined) as unknown as PageRouteHandler;
    const handler = createNotFoundRouteHandler({ renderPage });
    const { context, sent, headers } = fakeContext("GET", "/prodcts", BROWSER_ACCEPT);

    await handler(context);

    expect(renderPage).toHaveBeenCalledTimes(1);
    // The page handler owns the response from here; nothing was written first.
    expect(sent).toEqual([]);
    expect(headers.get("cache-control")).toBe("no-store");
  });

  it("falls back to the framework default — a real document, with a real 404 status", async () => {
    const handler = createNotFoundRouteHandler({});
    const { context, sent, headers } = fakeContext("GET", "/prodcts", BROWSER_ACCEPT);

    await handler(context);

    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("html");
    expect(sent[0].status).toBe(404);
    expect(sent[0].body).toBe(frameworkDefaultNotFoundDocument());
    expect(headers).toEqual(new Map([["cache-control", "no-store"]]));
  });

  it("applies no-store to the standalone HEAD document fallback", async () => {
    const handler = createNotFoundRouteHandler({});
    const { context, sent, headers } = fakeContext("HEAD", "/prodcts", BROWSER_ACCEPT);

    await handler(context);

    expect(sent).toEqual([
      {
        kind: "html",
        status: 404,
        body: frameworkDefaultNotFoundDocument(),
      },
    ]);
    expect(headers).toEqual(new Map([["cache-control", "no-store"]]));
  });

  it("preserves the exact terminal core Response returned by the application's page", async () => {
    const terminal = new Response();
    const renderPage = vi.fn(async () => terminal) as unknown as PageRouteHandler;
    const handler = createNotFoundRouteHandler({ renderPage });
    const { context, sent, headers } = fakeContext("GET", "/prodcts", BROWSER_ACCEPT);

    const result = await handler(context);

    expect(result).toBe(terminal);
    expect(sent).toEqual([]);
    expect(headers).toEqual(new Map([["cache-control", "no-store"]]));
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
  it("is a complete, self-contained document with a quiet route home", () => {
    const html = frameworkDefaultNotFoundDocument();

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.match(/<html [^>]+>/)?.[0]).toBe('<html lang="en" dir="ltr">');
    expect(html).toContain("<head>");
    expect(html).toContain("<body>");
    expect(html).toContain("</html>");
    expect(html).toContain("<h1>404</h1>");
    expect(html).toContain('<p dir="auto">This page is outside the spellbook.</p>');
    expect(html).toContain('<a href="/" dir="auto">Return home</a>');
    expect(html.match(/<link rel="stylesheet" href="data:text\/css[^\"]+">/g)).toHaveLength(1);
    // CSS ships with the document: there is no external fetch, inline style, or script.
    expect(html).not.toContain("framework-default-not-found.css");
    expect(html).not.toContain("<style");
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("404.page.tsx");
    expect(html).not.toContain("src/web");
  });

  it("uses Intl.Locale's canonical Arabic locale and RTL direction", () => {
    const html = frameworkDefaultNotFoundDocument("ar-eg");

    expect(html.match(/<html [^>]+>/)?.[0]).toBe('<html lang="ar-EG" dir="rtl">');
  });

  it("uses Intl.Locale's canonical English locale and LTR direction", () => {
    const html = frameworkDefaultNotFoundDocument("en-us");

    expect(html.match(/<html [^>]+>/)?.[0]).toBe('<html lang="en-US" dir="ltr">');
  });

  it("falls back safely for missing or malformed locales and never throws", () => {
    for (const locale of [undefined, "", "not_a_locale"]) {
      expect(() => frameworkDefaultNotFoundDocument(locale)).not.toThrow();
      expect(frameworkDefaultNotFoundDocument(locale).match(/<html [^>]+>/)?.[0]).toBe(
        '<html lang="en" dir="ltr">',
      );
    }
  });

  it("receives the request locale through the default route handler", async () => {
    const handler = createNotFoundRouteHandler({});
    const { context, sent } = fakeContext("GET", "/prodcts", BROWSER_ACCEPT, "ar");

    await handler(context);

    expect(sent[0]).toMatchObject({ kind: "html", status: 404 });
    expect(String(sent[0].body).match(/<html [^>]+>/)?.[0]).toBe('<html lang="ar" dir="rtl">');
  });
});
