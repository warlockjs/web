import config from "@mongez/config";
import { Response, type Request } from "@warlock.js/core";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  publishLocaleRouting,
  resetLocaleRouting,
  type LocaleRouting,
} from "../routing/locale-routing";
import { connectCurrentSite } from "../routing/site-url";
import type { RequestSite } from "./site-dispatch";

vi.mock("../shared", () => ({
  enterSharedScope: vi.fn(),
  sealShared: vi.fn(async () => Object.freeze({})),
}));

import { connectPageContext, type PageRouteEntry } from "./execute-page-request";
import { renderPageRequest } from "./render-page";

/**
 * Card: the lead's `render-page.ts` fix (~line 1036) — `publicUrl` now reads
 * `siteOriginFor(request.site.host)` for a multi-site request instead of
 * ALWAYS reading the app's single `getPublicUrl()`. Before the fix, a
 * multi-site app's hreflang alternates (`resolveLocaleAlternates`) and its
 * canonical/og:url (`enrichMetadata`) both used the app's one public URL —
 * wrong (or absent) for every site whose host differs from it.
 *
 * This proves both ends of that one `publicUrl` value: `resolveLocaleAlternates`
 * (hreflang `<link>`s) and `enrichMetadata` (the canonical `<link>`) — the two
 * consumers named in `render-page.ts`'s own comment at the fix site — agree,
 * for a real request rendered end to end through `renderPageRequest`
 * (`render-page.spec.ts`'s own harness).
 */

const prefixExceptDefaultEnAr: LocaleRouting = {
  strategy: "prefix-except-default",
  codes: ["en", "ar"],
  defaultLocale: "en",
};

function homePageEntry(): PageRouteEntry {
  return {
    path: "/",
    name: "home",
    triple: {
      app: {},
      layout: {},
      // A static (non-function) `metadata` so `resolvePageMetadata` reports
      // "this page declared metadata" and `bundle.metadata` comes back `{}`
      // (truthy) rather than `undefined` — otherwise `enrichMetadata` short-
      // circuits on `metadata === undefined` and no canonical is derived at
      // all, which would prove nothing about the fix.
      page: { default: () => createElement("main", null, "home"), metadata: {} },
    },
  };
}

function createHttp(site: RequestSite | undefined) {
  const response = new Response();
  const request = { nonce: undefined, locale: "en", path: "/", site } as unknown as Request;

  return { request, response };
}

/** Every `href=` on a `rel="alternate"` hreflang `<link>` in the rendered document. */
function hreflangHrefs(html: string): string[] {
  return [...html.matchAll(/<link rel="alternate" hrefLang="[^"]*" href="([^"]*)"/g)].map(
    (match) => match[1]!,
  );
}

/** The `href=` on the rendered `rel="canonical"` `<link>`, if any. */
function canonicalHref(html: string): string | undefined {
  return /<link rel="canonical" href="([^"]*)"/.exec(html)?.[1];
}

beforeEach(() => {
  connectPageContext({
    buildStore: (payload) => payload as never,
    getStore: () => undefined,
    run: async (_store, callback) => callback(),
  });
});

afterEach(() => {
  resetLocaleRouting();
  connectCurrentSite(undefined);
  config.set("app", {});
});

describe("render-page — site origin for hreflang alternates and canonical (multi-site publicUrl fix)", () => {
  it.each([
    ["unset", undefined],
    ["a different origin", "https://wrong.test"],
  ])(
    "multi-site: publicUrl for THIS request's site (estates.test), never the app's own — app.publicUrl %s",
    async (_label, appPublicUrl) => {
      config.set("app", appPublicUrl === undefined ? {} : { publicUrl: appPublicUrl });
      publishLocaleRouting(prefixExceptDefaultEnAr, "landing");
      connectCurrentSite(() => ({ key: "landing", host: "estates.test", basePath: "" }));

      const site: RequestSite = { key: "landing", host: "estates.test", basePath: "" };
      const { request, response } = createHttp(site);

      const rendered = await renderPageRequest("/", {
        routes: [homePageEntry()],
        createHttp: () => ({ request, response }),
      });

      if (rendered instanceof Response) throw new Error("unexpected terminal Response");

      const hrefs = hreflangHrefs(rendered.html);
      // prefix-except-default over ["en", "ar"] emits en bare, ar prefixed, and x-default.
      expect(hrefs).toHaveLength(3);
      for (const href of hrefs) {
        expect(href).toMatch(/^https?:\/\/estates\.test(\/|$)/);
      }

      const canonical = canonicalHref(rendered.html);
      expect(canonical).toBeDefined();
      expect(canonical).toMatch(/^https?:\/\/estates\.test(\/|$)/);
    },
  );

  it("single-site: request.site is undefined, hreflang alternates and canonical still use getPublicUrl()", async () => {
    config.set("app", { publicUrl: "https://app.test" });
    publishLocaleRouting(prefixExceptDefaultEnAr);
    connectCurrentSite(undefined);

    const { request, response } = createHttp(undefined);

    const rendered = await renderPageRequest("/", {
      routes: [homePageEntry()],
      createHttp: () => ({ request, response }),
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    const hrefs = hreflangHrefs(rendered.html);
    expect(hrefs).toHaveLength(3);
    for (const href of hrefs) {
      expect(href).toMatch(/^https:\/\/app\.test(\/|$)/);
    }

    expect(canonicalHref(rendered.html)).toBe("https://app.test/");
  });
});
