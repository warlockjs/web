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

vi.mock("../shared", () => ({
  enterSharedScope: vi.fn(),
  sealShared: vi.fn(async () => Object.freeze({})),
}));

import type { MetadataInput } from "../metadata";
import { connectPageContext, type PageRouteEntry } from "./execute-page-request";
import { renderPageRequest } from "./render-page";

/**
 * Real-estate #22: a page's resolved `metadata.alternates` REPLACES the
 * framework's generated locale-alternate set entirely — mixing same-slug
 * generated entries alongside the page's real, per-locale slugs was the bug.
 */

const prefixExceptDefaultEnAr: LocaleRouting = {
  strategy: "prefix-except-default",
  codes: ["en", "ar"],
  defaultLocale: "en",
};

/** Every `<link rel="alternate" hrefLang=...>` tag in the rendered document, as `{ hreflang, href }`. */
function alternateLinks(html: string): { hreflang: string; href: string }[] {
  const generated = [
    ...html.matchAll(/<link rel="alternate" hrefLang="([^"]*)" href="([^"]*)"/g),
  ].map((match) => ({ hreflang: match[1]!, href: match[2]! }));
  const fromMetadata = [
    ...html.matchAll(/<link rel="alternate" href="([^"]*)" hrefLang="([^"]*)"/g),
  ].map((match) => ({ hreflang: match[2]!, href: match[1]! }));

  return [...generated, ...fromMetadata];
}

function createHttp() {
  const response = new Response();
  const request = {
    nonce: undefined,
    locale: "en",
    path: "/posts/x",
    site: undefined,
  } as unknown as Request;

  return { request, response };
}

function entryWithMetadata(metadata: MetadataInput): PageRouteEntry {
  return {
    path: "/posts/:id",
    name: "post",
    triple: {
      app: {},
      layout: {},
      page: { default: () => createElement("main", null, "post"), metadata },
    },
  };
}

beforeEach(() => {
  connectPageContext({
    buildStore: (payload) => payload as never,
    getStore: () => undefined,
    run: async (_store, callback) => callback(),
  });
  config.set("app", { publicUrl: "https://app.test" });
  publishLocaleRouting(prefixExceptDefaultEnAr);
});

afterEach(() => {
  resetLocaleRouting();
  connectCurrentSite(undefined);
  config.set("app", {});
});

describe("render-page — metadata.alternates replaces generated locale alternates", () => {
  it("a page with no `alternates` keeps today's generated set, unchanged", async () => {
    const { request, response } = createHttp();

    const rendered = await renderPageRequest("/posts/x", {
      routes: [entryWithMetadata({})],
      createHttp: () => ({ request, response }),
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    const links = alternateLinks(rendered.html);

    expect(links).toEqual([
      { hreflang: "en", href: "https://app.test/posts/x" },
      { hreflang: "ar", href: "https://app.test/ar/posts/x" },
      { hreflang: "x-default", href: "https://app.test/posts/x" },
    ]);
  });

  it("a page with `alternates` suppresses the generated set entirely and emits only its own", async () => {
    const { request, response } = createHttp();

    const rendered = await renderPageRequest("/posts/x", {
      routes: [
        entryWithMetadata({
          alternates: {
            en: "/apartments-for-rent-in-zamalek",
            ar: "/شقق-للإيجار-في-الزمالك",
          },
        }),
      ],
      createHttp: () => ({ request, response }),
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    const links = alternateLinks(rendered.html);

    expect(links).toEqual([
      { hreflang: "en", href: "https://app.test/apartments-for-rent-in-zamalek" },
      { hreflang: "ar", href: "https://app.test/شقق-للإيجار-في-الزمالك" },
    ]);
  });

  it("`x-default` is only emitted when the page's own `alternates` provides it", async () => {
    const { request, response } = createHttp();

    const rendered = await renderPageRequest("/posts/x", {
      routes: [
        entryWithMetadata({
          alternates: {
            en: "/en-slug",
            ar: "/ar-slug",
            "x-default": "/en-slug",
          },
        }),
      ],
      createHttp: () => ({ request, response }),
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    const links = alternateLinks(rendered.html);

    expect(links).toEqual([
      { hreflang: "en", href: "https://app.test/en-slug" },
      { hreflang: "ar", href: "https://app.test/ar-slug" },
      { hreflang: "x-default", href: "https://app.test/en-slug" },
    ]);
  });

  it("an absolute URL in `alternates` is used as-is, never re-joined onto the origin", async () => {
    const { request, response } = createHttp();

    const rendered = await renderPageRequest("/posts/x", {
      routes: [
        entryWithMetadata({
          alternates: { en: "https://other.test/en-slug" },
        }),
      ],
      createHttp: () => ({ request, response }),
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    expect(alternateLinks(rendered.html)).toEqual([
      { hreflang: "en", href: "https://other.test/en-slug" },
    ]);
  });

  it("works when `metadata` is a function of the loader's data (dynamic listing slugs)", async () => {
    const { request, response } = createHttp();

    const entry: PageRouteEntry = {
      path: "/posts/:id",
      name: "post",
      triple: {
        app: {},
        layout: {},
        page: {
          default: () => createElement("main", null, "post"),
          loader: () => ({ slug: { en: "loader-en-slug", ar: "loader-ar-slug" } }),
          metadata: (context: { data: unknown }): MetadataInput => {
            const data = context.data as { slug: { en: string; ar: string } };

            return {
              alternates: {
                en: `/${data.slug.en}`,
                ar: `/${data.slug.ar}`,
              },
            };
          },
        },
      },
    };

    const rendered = await renderPageRequest("/posts/x", {
      routes: [entry],
      createHttp: () => ({ request, response }),
    });

    if (rendered instanceof Response) throw new Error("unexpected terminal Response");

    expect(alternateLinks(rendered.html)).toEqual([
      { hreflang: "en", href: "https://app.test/loader-en-slug" },
      { hreflang: "ar", href: "https://app.test/loader-ar-slug" },
    ]);
  });
});
