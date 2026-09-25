import { stringify } from "devalue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { submitPageAction } from "./submit-page-action";

const PAYLOAD = {
  appData: {},
  layoutData: {},
  pageData: {},
  shared: { locale: "en" },
  name: "contact",
  locale: "en",
  translations: {},
};

function respond(status: number, body = "", headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(async (..._args: unknown[]) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    url: "",
    text: async () => body,
  }));

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("submitPageAction", () => {
  it("POSTs the form with the data header", async () => {
    const fetchMock = respond(200, stringify(PAYLOAD), {
      "content-type": "application/json; charset=utf-8",
    });
    const form = new FormData();

    await submitPageAction("/contact", form);

    const init = fetchMock.mock.calls[0][1] as RequestInit;

    expect(init.method).toBe("POST");
    expect(init.body).toBe(form);
    expect((init.headers as Record<string, string>)["x-warlock-data"]).toBeDefined();
  });

  it("returns the payload on 200", async () => {
    respond(200, stringify(PAYLOAD), { "content-type": "application/json" });

    const result = await submitPageAction("/contact", new FormData());

    expect(result.type).toBe("payload");
  });

  it("returns actionOnly for a 422 { actionData } body", async () => {
    respond(422, stringify({ actionData: { formErrors: ["x"] } }));

    expect(await submitPageAction("/contact", new FormData())).toEqual({
      type: "actionOnly",
      actionData: { formErrors: ["x"] },
      status: 422,
    });
  });

  it("returns redirect for 204 with x-warlock-redirect", async () => {
    respond(204, "", { "x-warlock-redirect": "/thanks" });

    expect(await submitPageAction("/contact", new FormData())).toEqual({
      type: "redirect",
      url: "/thanks",
    });
  });

  it("hard-fails for 204 without the header, a 422 without actionData, 500 and a network error", async () => {
    respond(204);
    expect((await submitPageAction("/c", new FormData())).type).toBe("hard-fail");

    respond(422, stringify({ other: 1 }));
    expect((await submitPageAction("/c", new FormData())).type).toBe("hard-fail");

    respond(500);
    expect((await submitPageAction("/c", new FormData())).type).toBe("hard-fail");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    expect((await submitPageAction("/c", new FormData())).type).toBe("hard-fail");
  });

  it("reports aborted, not hard-fail, when its own signal aborted", async () => {
    const controller = new AbortController();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        throw new Error("aborted");
      }),
    );

    expect(await submitPageAction("/c", new FormData(), controller.signal)).toEqual({
      type: "aborted",
    });
  });
});
