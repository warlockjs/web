import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HydrationDocumentPayloadSource } from "../../hydration-payload";

/**
 * `currentRoute()` / `previousRoute()` — and specifically the claim that makes
 * them different from MRR's: they answer off the SERVER's match.
 *
 * The case worth the most here is the FIRST one below. Before any client
 * navigation there is no swap to have recorded anything, and the server's match
 * is the only match that exists — so a `currentRoute()` that only becomes
 * correct after the first navigation is a `currentRoute()` that is wrong on
 * every landing, which is most page views.
 *
 * The module holds process-wide state on purpose (one document, one current
 * route), so each test takes a FRESH module graph rather than a reset hook:
 * `navigation-root` and `current-route` must be re-imported together or the
 * component would keep writing into the previous test's module instance.
 *
 * The suite runs in vitest's `node` environment (vitest.config.ts): there is no
 * `window` and no DOM unless a test makes one. That is what lets the
 * non-browser cases below be the default state rather than a simulation, and it
 * is why the mount case renders to static markup instead of mounting.
 */

type Modules = {
  currentRoute: typeof import("./current-route").currentRoute;
  previousRoute: typeof import("./current-route").previousRoute;
  recordCurrentRoute: typeof import("./current-route").recordCurrentRoute;
  NavigationRoot: typeof import("./navigation-root").NavigationRoot;
  applyDocumentMetadata: typeof import("./navigation-root").applyDocumentMetadata;
  useLocale: typeof import("../../localization").useLocale;
};

async function freshModules(): Promise<Modules> {
  vi.resetModules();

  const { currentRoute, previousRoute, recordCurrentRoute } = await import("./current-route");
  const { NavigationRoot, applyDocumentMetadata } = await import("./navigation-root");
  const { useLocale } = await import("../../localization");

  return {
    currentRoute,
    previousRoute,
    recordCurrentRoute,
    NavigationRoot,
    applyDocumentMetadata,
    useLocale,
  };
}

function payloadOf(
  name: string,
  params?: Record<string, string>,
  locale = "en",
): HydrationDocumentPayloadSource {
  return {
    appData: {},
    layoutData: {},
    pageData: {},
    shared: {},
    name,
    locale,
    // Spread, never `params: undefined`: a payload without params has no such
    // key, and the reader's fallback is only proven against real absence.
    ...(params === undefined ? {} : { params }),
  };
}

/** Never reached: the mount cases render the initial tree, which is given. */
const buildTree = async (): Promise<ReactNode> => null;

/**
 * Render `NavigationRoot` the way hydration does — with the payload the
 * document was rendered from — and report what the page tree saw while IT was
 * rendering, which is the moment a page component would call `currentRoute()`.
 */
function renderInitialMount(
  modules: Modules,
  payload: HydrationDocumentPayloadSource,
  probe: () => ReactNode,
): string {
  return renderToStaticMarkup(
    createElement(modules.NavigationRoot, {
      pages: [],
      initialPayload: payload,
      initialTree: createElement(probe),
      buildTree,
    }),
  );
}

let modules: Modules;

beforeEach(async () => {
  modules = await freshModules();
});

describe("currentRoute", () => {
  it("hydrates the page under the locale declared by the server payload", () => {
    const markup = renderInitialMount(modules, payloadOf("main.home", undefined, "ar"), () =>
      createElement("span", null, modules.useLocale()),
    );

    expect(markup).toContain("ar");
  });

  /**
   * THE case. No navigation has happened, nothing has been fetched, and the
   * page tree is mid-render — and the answer is already the entry the server
   * matched, because the hydration payload carried its name.
   */
  it("is the server's matched entry while the initial tree is still rendering", () => {
    const seen: (string | undefined)[] = [];

    const markup = renderInitialMount(modules, payloadOf("products.details"), () => {
      seen.push(modules.currentRoute()?.name);

      return createElement("span", null, modules.currentRoute()?.name ?? "none");
    });

    expect(seen).toEqual(["products.details"]);
    expect(markup).toContain("products.details");
  });

  it("is the server's matched entry after the initial mount too", () => {
    renderInitialMount(modules, payloadOf("main.home"), () => null);

    expect(modules.currentRoute()).toEqual({ name: "main.home" });
  });

  /** Callable from a universal module during the server render. */
  it("returns undefined without throwing when nothing has been rendered", () => {
    expect(() => modules.currentRoute()).not.toThrow();
    expect(modules.currentRoute()).toBeUndefined();
  });

  it("is the newly swapped entry once a navigation records one", () => {
    modules.recordCurrentRoute(payloadOf("main.home"));
    modules.recordCurrentRoute(payloadOf("products.details"));

    expect(modules.currentRoute()).toEqual({ name: "products.details" });
  });

  /**
   * The params are the SERVER's — `bundle.route.params`, carried on the payload
   * — so this asserts a hand-off, not a match. Nothing in `current-route.ts`
   * may look at `location.pathname` to produce them.
   */
  it("reports the params the server matched, off the payload", () => {
    modules.recordCurrentRoute(payloadOf("products.details", { id: "42", slug: "a-chair" }));

    expect(modules.currentRoute()?.params).toEqual({ id: "42", slug: "a-chair" });
  });

  it("reports empty params for a route with no dynamic segments", () => {
    modules.recordCurrentRoute(payloadOf("main.home", {}));

    expect(modules.currentRoute()?.params).toEqual({});
  });

  /**
   * A payload with no `params` key at all — an older build, or a document
   * cached across a deploy. The answer is `undefined`, NOT `{}`, and the pair
   * of cases is the point: `{}` above is the server saying this route has no
   * params, and `undefined` here is the server not having said. Collapsing them
   * would report a matched-and-empty result for a payload that never carried
   * one, which a caller has no way to tell from the truth.
   */
  it("reports no params at all when the payload carries none", () => {
    modules.recordCurrentRoute(payloadOf("main.home"));

    expect(modules.currentRoute()).toEqual({ name: "main.home" });
    expect(modules.currentRoute()?.params).toBeUndefined();
  });

  it("does not hand out the payload's own params object", () => {
    const params = { id: "42" };

    modules.recordCurrentRoute(payloadOf("products.details", params));
    (modules.currentRoute()?.params as Record<string, string>).id = "99";

    expect(params).toEqual({ id: "42" });
  });
});

describe("previousRoute", () => {
  /** `undefined`, not a throw and not a copy of the current entry. */
  it("is undefined before any navigation has happened", () => {
    renderInitialMount(modules, payloadOf("main.home"), () => null);

    expect(modules.previousRoute()).toBeUndefined();
  });

  it("returns undefined without throwing when nothing has been rendered", () => {
    expect(() => modules.previousRoute()).not.toThrow();
    expect(modules.previousRoute()).toBeUndefined();
  });

  it("is the entry that was swapped out", () => {
    modules.recordCurrentRoute(payloadOf("main.home"));
    modules.recordCurrentRoute(payloadOf("products.details"));

    expect(modules.previousRoute()).toEqual({ name: "main.home" });
  });

  /**
   * A re-render is not a navigation. `NavigationRoot` records on every render
   * pass — that is what makes the mount case above work — so recording is keyed
   * on the payload's IDENTITY: one swap, one payload object, however many times
   * React renders it (StrictMode's double invoke, a parent re-render, a
   * `setState` elsewhere). Without this, simply rendering twice would report
   * the page you are on as the page you came from.
   */
  it("does not shift when the same payload is recorded again", () => {
    const payload = payloadOf("main.home");

    modules.recordCurrentRoute(payload);
    modules.recordCurrentRoute(payload);
    modules.recordCurrentRoute(payload);

    expect(modules.previousRoute()).toBeUndefined();
    expect(modules.currentRoute()).toEqual({ name: "main.home" });
  });

  /**
   * Two payload objects that matched the SAME entry are still two navigations
   * — `/users/1` to `/users/2` is a navigation. It is the identity that is
   * compared, never the name.
   */
  it("reports the same entry when a navigation stays within one route", () => {
    modules.recordCurrentRoute(payloadOf("users.details", { id: "1" }));
    modules.recordCurrentRoute(payloadOf("users.details", { id: "2" }));

    expect(modules.previousRoute()).toEqual({ name: "users.details", params: { id: "1" } });
    expect(modules.currentRoute()).toEqual({ name: "users.details", params: { id: "2" } });
  });
});

/**
 * `applyDocumentMetadata` — the half of the title bug that was never about the
 * wire.
 *
 * The payload carrying metadata is necessary and not sufficient: `<head>` is
 * rendered by `<Head/>` at the App level, and the App level is deliberately NOT
 * part of the hydrated tree (`client/build-hydrated-tree.ts`'s header) — the
 * client mounts at `#root`, inside the body. So no React render on the client
 * can reach the head, and a swap has to write it imperatively or not at all.
 *
 * The suite has no DOM (node environment), so the cases below run against a
 * fake document in the shape `hydration-payload.spec.ts` already uses for the
 * payload script. That is enough to prove the RULES — set, update, and
 * especially REMOVE — and not enough to prove the browser does what we think;
 * the title change is browser-verified separately.
 */

type FakeElement = {
  tagName: string;
  attributes: Record<string, string>;
  textContent: string;
  setAttribute(name: string, value: string): void;
  remove(): void;
};

/** Only the four selector shapes the applier uses. Anything else is a bug. */
const SELECTOR_PATTERN = /^([a-z]+)(?:\[([a-zA-Z-]+)="([^"]+)"\])?$/;

function matchesSelector(element: FakeElement, selector: string): boolean {
  const parsed = SELECTOR_PATTERN.exec(selector);

  if (!parsed) throw new Error(`The applier used an unsupported selector: ${selector}`);

  const [, tagName, attribute, value] = parsed;

  if (element.tagName !== tagName) return false;
  if (attribute === undefined) return true;

  return element.attributes[attribute] === value;
}

function fakeHead(initial: readonly { tagName: string; attributes?: Record<string, string>; textContent?: string }[]) {
  const elements: FakeElement[] = [];

  const make = (
    tagName: string,
    attributes: Record<string, string> = {},
    textContent = "",
  ): FakeElement => {
    const element: FakeElement = {
      tagName,
      attributes: { ...attributes },
      textContent,
      setAttribute(name, value) {
        element.attributes[name] = value;
      },
      remove() {
        const index = elements.indexOf(element);

        if (index >= 0) elements.splice(index, 1);
      },
    };

    return element;
  };

  for (const entry of initial) {
    elements.push(make(entry.tagName, entry.attributes, entry.textContent));
  }

  const documentNode = {
    head: {
      appendChild(element: FakeElement) {
        elements.push(element);
      },
    },
    createElement: (tagName: string) => make(tagName),
    querySelector: (selector: string) =>
      elements.find(element => matchesSelector(element, selector)) ?? null,
  } as unknown as Document;

  return { documentNode, elements };
}

/** What the head says now, in the terms the assertions are written in. */
function describeHead(elements: readonly FakeElement[]): string[] {
  return elements.map(element => {
    const attributes = Object.entries(element.attributes)
      .map(([name, value]) => `${name}=${value}`)
      .join(" ");

    return [element.tagName, attributes, element.textContent].filter(Boolean).join(" ");
  });
}

describe("applyDocumentMetadata", () => {
  /** THE bug: / -> /contact-us swapped the body and left the title reading "Home". */
  it("writes the new page's title into the existing title element", () => {
    const { documentNode, elements } = fakeHead([{ tagName: "title", textContent: "Home" }]);

    modules.applyDocumentMetadata(documentNode, { title: "Contact us" });

    expect(describeHead(elements)).toEqual(["title Contact us"]);
  });

  it("creates a title element when the document has none", () => {
    const { documentNode, elements } = fakeHead([]);

    modules.applyDocumentMetadata(documentNode, { title: "Contact us" });

    expect(describeHead(elements)).toEqual(["title Contact us"]);
  });

  /**
   * THE decision this block exists for. `/` sets a description, `/contact-us`
   * does not — leaving the previous page's description in the head describes
   * the new page with the old page's words to every crawler and share preview
   * that reads it. Absent means REMOVED, for every tag the applier manages.
   */
  it("removes a tag the previous page set and the new page does not", () => {
    const { documentNode, elements } = fakeHead([
      { tagName: "title", textContent: "Home" },
      { tagName: "meta", attributes: { name: "description" }, textContent: "" },
    ]);

    modules.applyDocumentMetadata(documentNode, { title: "Contact us" });

    expect(describeHead(elements)).toEqual(["title Contact us"]);
  });

  it("clears every managed tag when the new page has no metadata at all", () => {
    const { documentNode, elements } = fakeHead([
      { tagName: "meta", attributes: { charset: "utf-8" } },
      { tagName: "title", textContent: "Home" },
      { tagName: "meta", attributes: { name: "description", content: "6 products" } },
      { tagName: "meta", attributes: { property: "og:title", content: "Home" } },
      { tagName: "link", attributes: { rel: "canonical", href: "https://app.test/" } },
    ]);

    modules.applyDocumentMetadata(documentNode, undefined);

    // The charset meta survives: `<Head/>` renders it unconditionally, so it
    // belongs to the document rather than to any page's metadata.
    expect(describeHead(elements)).toEqual(["meta charset=utf-8"]);
  });

  it("updates an existing tag instead of appending a second one", () => {
    const { documentNode, elements } = fakeHead([
      { tagName: "meta", attributes: { name: "description", content: "6 products" } },
    ]);

    modules.applyDocumentMetadata(documentNode, { description: "How to reach us" });

    expect(describeHead(elements)).toEqual(["meta name=description content=How to reach us"]);
  });

  it("joins array keywords the way <Head/> does", () => {
    const { documentNode, elements } = fakeHead([]);

    modules.applyDocumentMetadata(documentNode, { keywords: ["contact", "support"] });

    expect(describeHead(elements)).toEqual(["meta name=keywords content=contact, support"]);
  });

  /**
   * `<Head/>`'s exact rule (`components/head.ts:22-23,43-48`): og:title falls
   * back to the top-level title, but ONLY when `openGraph` is present. The
   * applier mirrors it because the head after a navigation must equal the head
   * after landing on the same URL — two rules would make that comparison a
   * coin toss.
   */
  it("falls og:title back to the title only when openGraph is present", () => {
    const withoutOpenGraph = fakeHead([]);

    modules.applyDocumentMetadata(withoutOpenGraph.documentNode, { title: "Contact us" });

    expect(describeHead(withoutOpenGraph.elements)).toEqual(["title Contact us"]);

    const withOpenGraph = fakeHead([]);

    modules.applyDocumentMetadata(withOpenGraph.documentNode, {
      title: "Contact us",
      openGraph: { image: "https://app.test/og.png" },
    });

    expect(describeHead(withOpenGraph.elements)).toEqual([
      "title Contact us",
      "meta property=og:title content=Contact us",
      "meta property=og:image content=https://app.test/og.png",
    ]);
  });

  it("writes the twitter and canonical tags", () => {
    const { documentNode, elements } = fakeHead([]);

    modules.applyDocumentMetadata(documentNode, {
      canonical: "https://app.test/contact-us",
      robots: "index,follow",
      twitter: { card: "summary", title: "Contact us" },
    });

    // Appended in `<Head/>`'s own order: canonical, then robots, then twitter.
    expect(describeHead(elements)).toEqual([
      "link rel=canonical href=https://app.test/contact-us",
      "meta name=robots content=index,follow",
      "meta name=twitter:card content=summary",
      "meta name=twitter:title content=Contact us",
    ]);
  });
});
