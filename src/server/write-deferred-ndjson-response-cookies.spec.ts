import { describe, expect, it } from "vitest";
import { createCoreHttp } from "./__fixtures__/core-http";
import type { PageDataBundle } from "./execute-page-request";
import { writeDeferredNdjsonResponse } from "./write-deferred-ndjson-response";

describe("writeDeferredNdjsonResponse() cookies", () => {
  it("carries a cookie set during the render on the NDJSON response's Set-Cookie header", async () => {
    const bundle: PageDataBundle = {
      route: { name: "dashboard", path: "/dashboard", params: {}, query: {} },
      appData: {},
      layoutData: {},
      pageData: { greeting: "hi", a: Promise.resolve(1) },
      shared: {} as never,
      deferredKeys: ["a"],
      deferredSettlements: { a: Promise.resolve({ ok: true, value: 1 } as const) },
    };

    const http = createCoreHttp({ url: "/dashboard" });

    // Set during the render, before the writer takes over the raw stream.
    http.response.cookie("ab_bucket", "b");

    await writeDeferredNdjsonResponse(http.response, bundle, "en", 200);

    const setCookie = http.reply.appliedHeaders["set-cookie"];
    const values = Array.isArray(setCookie) ? setCookie : [String(setCookie)];

    expect(values.some(value => value.startsWith("ab_bucket="))).toBe(true);
  });
});
