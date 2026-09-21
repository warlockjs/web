import { describe, expect, it } from "vitest";
import type { DiscoveredPageGraph } from "./discover-pages";
import { buildRouteLocaleManifest } from "./build-route-locale-manifest";
import { assertRouteLocaleKeyOwnership } from "./route-locale-key-ownership";

const root = "/app/src/web";

function graph(
  pages: Array<{ pageFile: string; webRoot?: string; type?: "page" | "error" }>,
  localeFiles: Array<{ sourceFile: string; webRoot?: string }>,
): DiscoveredPageGraph {
  return {
    pages: pages.map((page) =>
      page.type === "error"
        ? { type: "error", pageFile: page.pageFile, webRoot: page.webRoot ?? root }
        : {
            type: "page",
            pageFile: page.pageFile,
            webRoot: page.webRoot ?? root,
            routeName: "test",
            routePath: "/test",
            layouts: [],
            middlewareLayouts: [],
          },
    ),
    localeFiles: localeFiles.map((file) => ({
      sourceFile: file.sourceFile,
      webRoot: file.webRoot ?? root,
    })),
  };
}

function sources(files: Record<string, string>): (file: string) => string {
  return (file) => {
    const content = files[file];
    if (content === undefined) throw new Error(`unexpected source read: ${file}`);
    return content;
  };
}

const options = { localeCodes: ["en", "ar"], localeCode: "en" };

describe("buildRouteLocaleManifest", () => {
  it("does nothing when the graph contains no locales JSON files", () => {
    expect(buildRouteLocaleManifest(graph([], []), options)).toBeUndefined();
  });

  it("projects root and nested declarations into routable and error-page ancestry", () => {
    const files = {
      "/app/src/web/locales.json": '{"common":{"title":{"en":"Home","ar":"الرئيسية"}}}',
      "/app/src/web/account/locales.json": '{"$group":"account","save":{"en":"Save","ar":"حفظ"}}',
    };
    const result = buildRouteLocaleManifest(
      graph(
        [
          { pageFile: "/app/src/web/account/settings.page.tsx" },
          { pageFile: "/app/src/web/account/error.page.tsx", type: "error" },
          { pageFile: "/app/src/web/other.page.tsx" },
        ],
        Object.keys(files).map((sourceFile) => ({ sourceFile })),
      ),
      { ...options, readSource: sources(files) },
    );

    expect(result?.keys).toEqual(["account.save", "common.title"]);
    expect(result?.pages["/app/src/web/account/settings.page.tsx"]).toMatchObject({
      sourceFiles: ["/app/src/web/locales.json", "/app/src/web/account/locales.json"],
      translationsByLocale: {
        en: { common: { title: "Home" }, account: { save: "Save" } },
        ar: { common: { title: "الرئيسية" }, account: { save: "حفظ" } },
      },
    });
    expect(result?.pages["/app/src/web/account/error.page.tsx"]?.sourceFiles).toHaveLength(2);
    expect(result?.pages["/app/src/web/other.page.tsx"]?.translationsByLocale.en).toEqual({
      common: { title: "Home" },
    });
  });

  it("does not confuse a sibling prefix with an ancestor directory", () => {
    const rootFile = "/app/src/web/account/locales.json";
    const result = buildRouteLocaleManifest(
      graph([{ pageFile: "/app/src/web/accounting/page.page.tsx" }], [{ sourceFile: rootFile }]),
      {
        ...options,
        readSource: sources({ [rootFile]: '{"$group":"account","x":{"en":"x","ar":"y"}}' }),
      },
    );

    expect(result?.pages["/app/src/web/accounting/page.page.tsx"]?.sourceFiles).toEqual([]);
  });

  it("keeps a descendant whose directory merely begins with '..' inside its owner", () => {
    const sourceFile = "/app/src/web/a/locales.json";
    const pageFile = "/app/src/web/a/..published/page.page.tsx";
    const result = buildRouteLocaleManifest(graph([{ pageFile }], [{ sourceFile }]), {
      ...options,
      readSource: sources({
        [sourceFile]: '{"$group":"a","x":{"en":"x","ar":"y"}}',
      }),
    });

    expect(result?.pages[pageFile]?.sourceFiles).toEqual([sourceFile]);
  });

  it("reads every locale file once and orders root scopes before descendants", () => {
    const first = "/app/src/web/locales.json";
    const second = "/app/src/web/a/locales.json";
    const reads = new Map<string, number>();
    const result = buildRouteLocaleManifest(
      graph(
        [{ pageFile: "/app/src/web/a/page.page.tsx" }],
        [{ sourceFile: second }, { sourceFile: first }],
      ),
      {
        ...options,
        readSource: (file) => {
          reads.set(file, (reads.get(file) ?? 0) + 1);
          return file === first
            ? '{"root":{"en":"root","ar":"root"}}'
            : '{"$group":"a","child":{"en":"child","ar":"child"}}';
        },
      },
    );

    expect(reads).toEqual(
      new Map([
        [first, 1],
        [second, 1],
      ]),
    );
    expect(result?.pages["/app/src/web/a/page.page.tsx"]?.sourceFiles).toEqual([first, second]);
  });

  it.each([
    [{ localeCodes: undefined, localeCode: undefined }, /localeCodes/],
    [{ localeCodes: ["en", "en"], localeCode: "en" }, /duplicate/],
    [{ localeCodes: ["en", "ar"], localeCode: "fr" }, /not present/],
  ])("requires a valid configured locale set when JSON exists", (configuration, message) => {
    expect(() =>
      buildRouteLocaleManifest(graph([], [{ sourceFile: "/app/src/web/locales.json" }]), {
        ...configuration,
        readSource: sources({ "/app/src/web/locales.json": '{"x":{"en":"x","ar":"y"}}' }),
      }),
    ).toThrow(message);
  });

  it("rejects duplicate and namespace-prefix keys across owners", () => {
    const first = "/one/src/web/locales.json";
    const second = "/two/src/web/locales.json";
    const duplicate = () =>
      buildRouteLocaleManifest(
        graph(
          [],
          [
            { sourceFile: first, webRoot: "/one/src/web" },
            { sourceFile: second, webRoot: "/two/src/web" },
          ],
        ),
        {
          ...options,
          readSource: sources({
            [first]: '{"shared":{"title":{"en":"One","ar":"واحد"}}}',
            [second]: '{"shared":{"title":{"en":"Two","ar":"اثنان"}}}',
          }),
        },
      );
    const prefix = () =>
      buildRouteLocaleManifest(
        graph(
          [],
          [
            { sourceFile: first, webRoot: "/one/src/web" },
            { sourceFile: second, webRoot: "/two/src/web" },
          ],
        ),
        {
          ...options,
          readSource: sources({
            [first]: '{"shared":{"en":"One","ar":"واحد"}}',
            [second]: '{"shared":{"title":{"en":"Two","ar":"اثنان"}}}',
          }),
        },
      );

    expect(duplicate).toThrow(/both/);
    expect(prefix).toThrow(/namespace/);
  });
});

describe("assertRouteLocaleKeyOwnership", () => {
  it("detects a prefix collision despite lexically intervening non-prefix keys", () => {
    expect(() =>
      assertRouteLocaleKeyOwnership([
        { sourceFile: "one", entries: { a: { en: "one" }, "a-b": { en: "two" } } },
        { sourceFile: "two", entries: { "a.b": { en: "three" } } },
      ]),
    ).toThrow(/namespace/);
  });
});
