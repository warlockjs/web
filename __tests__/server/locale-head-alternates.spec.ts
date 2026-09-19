/**
 * Card D, design note §D.2: `<head>` hreflang alternates on a locale-routed
 * page, rendered end to end through `renderPageRequest` — real routes, real
 * config, real `<Head/>` — proving `render-page.ts`'s wiring
 * (`resolveLocaleAlternates`) actually reaches the document, not just the
 * pure resolver unit-tested in `src/server/resolve-locale-alternates.spec.ts`.
 */
import config from "@mongez/config";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectPageContext,
  renderPageRequest,
  type PageContextRunner,
  type PageRouteEntry,
} from "../../src/server/index";
import { connectSharedStore, type SharedStoreResolver } from "../../src/shared";
import { createCoreHttp, requestContext } from "../../src/server/__fixtures__/core-http";
import { publishLocaleRouting } from "../../src/routing/locale-routing";
import * as App from "./fixtures/root";
import * as contactPage from "./fixtures/contact.page";
import * as layout from "./fixtures/layout";

const canonicalPage = {
  ...contactPage,
  metadata: { canonical: "https://app.test/ar/posts/x" },
};

const routes: PageRouteEntry[] = [
  {
    path: "/ar/canonical/:id",
    name: "canonical",
    triple: { app: App, layout, page: canonicalPage },
  },
  { path: "/posts/:id", name: "posts.details", triple: { app: App, layout, page: contactPage } },
  {
    path: "/ar/posts/:id",
    name: "posts.details",
    triple: { app: App, layout, page: contactPage },
  },
  {
    path: "/:locale/about",
    name: "about",
    triple: { app: App, layout, page: contactPage },
  },
];

const createHttp = (url: string) => (match: { params: Record<string, string> }) =>
  createCoreHttp({ url, params: match.params, query: {} });

const renderRequest = (url: string) =>
  renderPageRequest(url, { routes, createHttp: createHttp(url) });

let previousRunner: PageContextRunner | undefined;
let previousResolver: SharedStoreResolver | undefined;

beforeAll(() => {
  previousRunner = connectPageContext(requestContext as unknown as PageContextRunner);
  previousResolver = connectSharedStore(() => requestContext.getStore() as any);
});

afterAll(() => {
  connectPageContext(previousRunner);
  connectSharedStore(previousResolver);
});

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  config.set("app", { publicUrl: "https://app.test", localeCodes: ["en", "ar"], localeCode: "en" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  config.set("app", {});
  publishLocaleRouting({ strategy: "none", codes: [], defaultLocale: "" });
});

describe("<head> alternates — prefix-except-default", () => {
  beforeEach(() => {
    publishLocaleRouting({
      strategy: "prefix-except-default",
      codes: ["en", "ar"],
      defaultLocale: "en",
    });
  });

  it("renders en bare, ar prefixed, and x-default bare on the default-locale request", async () => {
    const { html } = await renderRequest("/posts/x");

    expect(html).toContain('<link rel="alternate" hrefLang="en" href="https://app.test/posts/x"/>');
    expect(html).toContain(
      '<link rel="alternate" hrefLang="ar" href="https://app.test/ar/posts/x"/>',
    );
    expect(html).toContain(
      '<link rel="alternate" hrefLang="x-default" href="https://app.test/posts/x"/>',
    );
  });

  it("renders the same alternate set from the ar-prefixed request", async () => {
    const { html } = await renderRequest("/ar/posts/x");

    expect(html).toContain('<link rel="alternate" hrefLang="en" href="https://app.test/posts/x"/>');
    expect(html).toContain(
      '<link rel="alternate" hrefLang="ar" href="https://app.test/ar/posts/x"/>',
    );
  });
});

describe("<head> alternates — a page with its own canonical", () => {
  beforeEach(() => {
    publishLocaleRouting({
      strategy: "prefix-except-default",
      codes: ["en", "ar"],
      defaultLocale: "en",
    });
  });

  it("keeps the page canonical and still emits the hreflang alternates", async () => {
    const { html } = await renderRequest("/ar/canonical/x");

    expect(html).toContain("https://app.test/ar/posts/x");
    expect(html).toContain('rel="alternate" hrefLang="ar"');
    expect(html).toContain('rel="alternate" hrefLang="x-default"');
  });
});

describe("<head> alternates — strategy none, no :locale route", () => {
  beforeEach(() => {
    publishLocaleRouting({ strategy: "none", codes: ["en", "ar"], defaultLocale: "en" });
  });

  it("emits no alternate links", async () => {
    const { html } = await renderRequest("/posts/x");

    expect(html).not.toContain('rel="alternate"');
  });
});

describe("<head> alternates — a :locale route, strategy none", () => {
  beforeEach(() => {
    publishLocaleRouting({ strategy: "none", codes: ["en", "ar"], defaultLocale: "en" });
  });

  it("still emits alternates, prefixing every code including the default", async () => {
    const { html } = await renderRequest("/en/about");

    expect(html).toContain(
      '<link rel="alternate" hrefLang="en" href="https://app.test/en/about"/>',
    );
    expect(html).toContain(
      '<link rel="alternate" hrefLang="ar" href="https://app.test/ar/about"/>',
    );
  });
});
