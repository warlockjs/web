import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPageData } from "./fetch-page-data";

/**
 * `fetchPageData` — and specifically its refusals.
 *
 * The happy path is one test. The rest of this file is the contract that
 * matters: EVERY way this can go wrong resolves to `hard-navigate`, because a
 * client navigation is an optimisation and its failure mode has to be the
 * behaviour we had before it existed. A bug here should cost a page reload, not
 * a broken screen.
 */

const PAYLOAD = {
  appData: {},
  layoutData: {},
  pageData: { title: "Products" },
  shared: { locale: "en" },
  name: "products.list",
  locale: "en",
};

function respondWith(
  body: unknown,
  init: { status?: number; contentType?: string | null; url?: string } = {},
): void {
  const headers = new Headers();

  if (init.contentType !== null) {
    headers.set("content-type", init.contentType ?? "application/json; charset=utf-8");
  }

  const response = {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    headers,
    url: init.url ?? "",
    json: async () => {
      if (typeof body === "string") throw new SyntaxError("Unexpected token");

      return body;
    },
  };

  vi.stubGlobal("fetch", vi.fn(async () => response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchPageData", () => {
  it("returns the payload and sends the data marker with same-origin credentials", async () => {
    respondWith(PAYLOAD);

    const result = await fetchPageData("/products");

    expect(result).toEqual({ type: "payload", payload: PAYLOAD, url: "/products" });

    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];

    expect((init.headers as Record<string, string>)["x-warlock-data"]).toBe("1");
    // Without this a client navigation could be logged out while a full page
    // load of the same URL is not.
    expect(init.credentials).toBe("same-origin");
    expect(init.redirect).toBe("follow");
  });

  /**
   * The address bar must show where the user ENDED UP, not where they aimed.
   * A page behind auth answers from `/login`; pushing `/account` into history
   * would leave the URL lying about what is on screen.
   */
  it("reports the URL the response came from, so a followed redirect is not lost", async () => {
    respondWith({ ...PAYLOAD, name: "auth.login" }, { url: "https://app.test/login" });

    const result = await fetchPageData("/account/settings");

    expect(result).toEqual({
      type: "payload",
      payload: { ...PAYLOAD, name: "auth.login" },
      url: "https://app.test/login",
    });
  });

  it.each([
    ["a network failure", () => vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }))],
    ["a non-2xx status", () => respondWith(PAYLOAD, { status: 500 })],
    ["an HTML body from a portal or proxy", () => respondWith(PAYLOAD, { contentType: "text/html" })],
    ["a response with no content-type", () => respondWith(PAYLOAD, { contentType: null })],
    ["malformed JSON", () => respondWith("<!DOCTYPE html>")],
    ["a JSON body that is not a payload", () => respondWith({ error: "nope" })],
    ["a payload with no declared locale", () => {
      const { locale: _locale, ...withoutLocale } = PAYLOAD;
      respondWith(withoutLocale);
    }],
    ["a payload with an empty locale", () => respondWith({ ...PAYLOAD, locale: "" })],
  ])("falls back to a real navigation on %s", async (_label, arrange) => {
    arrange();

    const result = await fetchPageData("/products");

    expect(result.type).toBe("hard-navigate");
    expect(result.url).toBe("/products");
    // A reason is always given — this path is silent to the user, so the
    // console is the only place the cause can surface.
    expect((result as { reason: string }).reason.length).toBeGreaterThan(0);
  });

  /**
   * A 404 has a real page the server renders, with the correct status. Handing
   * it back to the browser gets both; inventing a client-side "not found" state
   * would duplicate the server's error page and get the status wrong.
   */
  it("does not treat a 404 as a payload even when the body parses", async () => {
    respondWith({ error: "not_found" }, { status: 404 });

    expect((await fetchPageData("/nope")).type).toBe("hard-navigate");
  });
});
