// @vitest-environment jsdom
import { act, createElement } from "react";
import { stringify } from "devalue";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Keywords } from "@mongez/localization";
import type { HydrationDocumentPayloadSource } from "../../hydration-payload";
import { useLocale, useTrans } from "../../localization";
import { currentNavigator } from "../../routing/navigator";
import { buildHydratedTree } from "../build-hydrated-tree";
import type { ClientPageEntry, ClientRouteComposition } from "../runtime/types";
import { NavigationRoot } from "./navigation-root";
import { resetScrollPositions } from "./scroll-positions";
import { resetManualScrollRestorationInstalled } from "./scroll-restoration";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function ScopedPage() {
  const trans = useTrans();
  const locale = useLocale();

  return createElement(
    "div",
    { "data-testid": "page", "data-locale": locale },
    `${String(trans("only.a"))}|${String(trans("only.b"))}`,
  );
}

function entry(name: string): ClientPageEntry {
  return {
    type: "page",
    name,
    path: `/${name}`,
    load: () => ({ Page: { register: () => {}, default: ScopedPage }, layouts: [] }),
  };
}

const pages = [entry("page.a"), entry("page.b"), entry("page.c")];

function payload(
  name: string,
  locale: string,
  translations: Keywords,
): HydrationDocumentPayloadSource {
  return {
    appData: {},
    layoutData: {},
    pageData: {},
    shared: {},
    name,
    locale,
    translations,
    translationMode: "scoped",
  };
}

function stubFetch(responses: Record<string, HydrationDocumentPayloadSource>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const path = new URL(String(input), window.location.href).pathname;
      const response = responses[path];
      if (response === undefined) throw new Error(`No payload for ${path}`);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        url: new URL(path, window.location.href).href,
        text: async () => stringify(response),
      };
    }),
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetScrollPositions();
  resetManualScrollRestorationInstalled();
  window.history.replaceState(null, "", "/a");
  vi.stubGlobal("scrollTo", vi.fn());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetScrollPositions();
  resetManualScrollRestorationInstalled();
});

async function mount(
  initialPayload: HydrationDocumentPayloadSource,
  buildTree = buildHydratedTree,
): Promise<void> {
  const initialTree = await buildHydratedTree(pages, initialPayload);
  await act(async () => {
    root.render(createElement(NavigationRoot, { pages, initialPayload, initialTree, buildTree }));
  });
}

function pageText(): string | null | undefined {
  return container.querySelector('[data-testid="page"]')?.textContent;
}

describe("NavigationRoot scoped payload copies", () => {
  it("replaces route A's selected keys with route B's keys", async () => {
    const a = payload("page.a", "en", { only: { a: "A" } });
    const b = payload("page.b", "ar", { only: { b: "B" } });
    stubFetch({ "/b": b });
    await mount(a);

    expect(pageText()).toBe("A|only.b");
    act(() => currentNavigator()?.("/b"));
    await flush();

    expect(pageText()).toBe("only.a|B");
    expect(container.querySelector('[data-testid="page"]')?.getAttribute("data-locale")).toBe("ar");
  });

  it("leaves the active copy and locale alone when the candidate tree fails", async () => {
    const a = payload("page.a", "en", { only: { a: "A" } });
    const b = payload("page.b", "ar", { only: { b: "B" } });
    stubFetch({ "/b": b });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await mount(a, async (entries, candidate) => {
      if (candidate.name === "page.b") throw new Error("chunk failed");
      return buildHydratedTree(entries, candidate);
    });

    act(() => currentNavigator()?.("/b"));
    await flush();

    expect(pageText()).toBe("A|only.b");
    expect(container.querySelector('[data-testid="page"]')?.getAttribute("data-locale")).toBe("en");
  });

  it("drops a superseded candidate tree without exposing its copy or locale", async () => {
    const a = payload("page.a", "en", { only: { a: "A" } });
    const b = payload("page.b", "ar", { only: { b: "B" } });
    const c = payload("page.c", "fr", { only: { b: "C" } });
    stubFetch({ "/b": b, "/c": c });

    let releaseB: () => void = () => undefined;
    const bTreeStarted = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    await mount(a, async (entries, candidate) => {
      if (candidate.name === "page.b") await bTreeStarted;
      return buildHydratedTree(entries, candidate);
    });

    act(() => currentNavigator()?.("/b"));
    await flush();
    expect(pageText()).toBe("A|only.b");
    expect(container.querySelector('[data-testid="page"]')?.getAttribute("data-locale")).toBe("en");

    act(() => currentNavigator()?.("/c"));
    await flush();
    expect(pageText()).toBe("only.a|C");
    expect(container.querySelector('[data-testid="page"]')?.getAttribute("data-locale")).toBe("fr");

    releaseB();
    await flush();
    expect(pageText()).toBe("only.a|C");
    expect(container.querySelector('[data-testid="page"]')?.getAttribute("data-locale")).toBe("fr");
  });
});
