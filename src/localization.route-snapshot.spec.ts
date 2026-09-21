// @vitest-environment jsdom
import { act, createElement } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { DiscoveredPageGraph } from "./build/discover-pages";
import { buildRouteLocaleManifest } from "./build/build-route-locale-manifest";
import { useTrans, LocaleProvider } from "./localization";
import { createRouteTranslationsResolver } from "./server/route-translations";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const webRoot = "/app/src/web";
const pageFile = `${webRoot}/account/settings/page.page.tsx`;

function graph(): DiscoveredPageGraph {
  return {
    pages: [
      {
        type: "page",
        pageFile,
        webRoot,
        routeName: "account.settings",
        routePath: "/account/settings",
        layouts: [],
        middlewareLayouts: [],
      },
    ],
    localeFiles: [
      { sourceFile: `${webRoot}/locales.json`, webRoot },
      { sourceFile: `${webRoot}/account/locales.json`, webRoot },
      { sourceFile: `${webRoot}/account/settings/locales.json`, webRoot },
    ],
  };
}

const sources: Record<string, string> = {
  [`${webRoot}/locales.json`]: '{"site":{"title":{"en":"Site","ar":"الموقع"}}}',
  [`${webRoot}/account/locales.json`]: '{"$group":"profile","name":{"en":"Name","ar":"الاسم"}}',
  [`${webRoot}/account/settings/locales.json`]: '{"save":{"en":"Save","ar":"حفظ"}}',
};

function Copy() {
  const trans = useTrans();
  return createElement(
    "output",
    { "data-copy": "route" },
    [trans("site.title"), trans("profile.name"), trans("account.settings.save")].join("|"),
  );
}

afterEach(() => document.body.replaceChildren());

describe("route locale snapshots through LocaleProvider", () => {
  it("hydrates SSR text without mismatches for root, nested, and $group keys", async () => {
    const manifest = buildRouteLocaleManifest(graph(), {
      localeCodes: ["en", "ar"],
      localeCode: "en",
      readSource: (file) => sources[file]!,
    });
    const snapshot = createRouteTranslationsResolver(manifest)!(pageFile, "ar");
    const element = createElement(LocaleProvider, {
      locale: snapshot.locale,
      translations: snapshot.keywords,
      children: createElement(Copy),
    });
    const ssr = renderToString(element);
    const container = document.createElement("div");
    container.innerHTML = ssr;
    document.body.appendChild(container);
    let root!: Root;
    const recoverableErrors: unknown[] = [];

    await act(async () => {
      root = hydrateRoot(container, element, {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
    });

    expect(ssr).toContain("الموقع|الاسم|حفظ");
    expect(container.querySelector("[data-copy='route']")?.textContent).toBe("الموقع|الاسم|حفظ");
    expect(recoverableErrors).toEqual([]);
    act(() => root.unmount());
  });
});
