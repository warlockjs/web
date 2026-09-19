/**
 * One spec per named case from the sitemap contract, so each is findable by
 * name in test output instead of hiding inside a differently-named `it()` in
 * one of the unit spec files. Each case below calls the real function it
 * exercises rather than re-deriving the assertion — where a unit spec
 * already covers the same behaviour in more depth, the comment says where.
 */
import config from "@mongez/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpContext, Router } from "@warlock.js/core";
import { collectSitemapEntries } from "./collect-sitemap-entries";
import { expandLocaleEntries } from "./expand-locale-entries";
import { generateSitemap } from "./generate-sitemap";
import { registerRobotsRoute } from "./register-robots-route";
import { registerWebHttpRoutes } from "./register-web-http-routes";

const temporaryDirectories: string[] = [];

function makeAppTree(files: Record<string, string>): string {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-sitemap-case-matrix-"));
  temporaryDirectories.push(appRoot);

  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(appRoot, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf-8");
  }

  return appRoot;
}

function capturingRouter() {
  const routes = new Map<string, (context: HttpContext) => unknown>();
  const router = {
    get: vi.fn((routePath: string, handler: (context: HttpContext) => unknown) => {
      routes.set(routePath, handler);
    }),
  } as unknown as Router;

  return { router, routes };
}

const noLocales = { codes: [] as string[] };

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }

  config.set("app", {});
  config.set("web", {});
});

describe("sitemap case matrix", () => {
  it("case: static — a plain static page becomes one entry at its own path (full coverage: collect-sitemap-entries.spec.ts)", async () => {
    const appRoot = makeAppTree({
      "src/web/about.page.tsx": [
        'export const route = "/about";',
        "export default function Page() { return null; }",
      ].join("\n"),
    });

    const { items } = await collectSitemapEntries({ appRoot, locales: noLocales });

    expect(items).toEqual([{ entry: { path: "/about" } }]);
  });

  it("case: dynamic — a dynamic page's sitemap() supplier contributes its concrete URLs under its route pattern (full coverage: collect-sitemap-entries.spec.ts, generate-sitemap.spec.ts)", async () => {
    const appRoot = makeAppTree({
      "src/web/posts/[id].page.tsx": [
        'export const sitemap = async () => [{ path: "/posts/hello-world" }];',
        "export default function Page() { return null; }",
      ].join("\n"),
    });

    const { items, declaredRoutes } = await collectSitemapEntries({ appRoot, locales: noLocales });

    expect(items.map((item) => item.entry.path)).toEqual(["/posts/hello-world"]);
    expect(declaredRoutes).toEqual(new Set(["/posts/:id"]));
  });

  it("case: locale-invariant — `locales: false` yields one entry with zero alternates even with locales configured (full coverage: collect-sitemap-entries.spec.ts, expand-locale-entries.spec.ts)", async () => {
    const appRoot = makeAppTree({
      "src/web/privacy.page.tsx": [
        "export const sitemap = { locales: false };",
        "export default function Page() { return null; }",
      ].join("\n"),
    });

    const { items } = await collectSitemapEntries({ appRoot, locales: { codes: ["en", "ar"] } });

    expect(items).toEqual([{ entry: { path: "/privacy" } }]);
  });

  it("case: divergent-slug — a page's own localePaths wins over the derived `?locale=` form for that locale (full coverage: expand-locale-entries.spec.ts)", () => {
    const result = expandLocaleEntries(
      { path: "/about", localePaths: { ar: "/about-ar" } },
      undefined,
      { codes: ["en", "ar"] },
    );

    expect(result.map((item) => item.entry.path)).toEqual(["/about?locale=en", "/about-ar"]);
  });

  it("case: split-locale — web.sitemap.locales.splitByLocale writes a SitemapIndex with one source per locale (full coverage: generate-sitemap.spec.ts)", async () => {
    const appRoot = makeAppTree({
      "src/web/about.page.tsx": [
        'export const route = "/about";',
        "export default function Page() { return null; }",
      ].join("\n"),
    });

    config.set("app", { publicUrl: "https://example.test", localeCodes: ["en", "ar"] });
    config.set("web", {
      sitemap: {
        enabled: true,
        outputDir: path.join(appRoot, "storage", "sitemap"),
        locales: { splitByLocale: true },
      },
    });

    const result = await generateSitemap({ appRoot });

    expect("indexPath" in result).toBe(true);
    if (!("indexPath" in result)) throw new Error("expected index mode");
    const keys = result.files.filter((file) => file.urls > 0).map((file) => file.key);
    expect(keys.sort()).toEqual(["ar", "en"]);
  });

  it("case: disabled — web.sitemap.enabled: false registers no sitemap routes and omits the automatic Sitemap: robots line (full coverage: register-web-http-routes.spec.ts, register-robots-route.spec.ts)", async () => {
    config.set("web", {
      robots: { enabled: true, groups: [{ userAgent: "*" }] },
      sitemap: { enabled: false },
    });

    const httpRoutesRouter = capturingRouter();
    await registerWebHttpRoutes(httpRoutesRouter.router, { appRoot: "/app" });
    expect(httpRoutesRouter.router.get).not.toHaveBeenCalledWith("/sitemap.xml", expect.anything());

    const robotsRouter = capturingRouter();
    registerRobotsRoute(robotsRouter.router, { publicDir: makeAppTree({}) });

    const response = { text: vi.fn() };
    await robotsRouter.routes.get("/robots.txt")!({
      request: {} as never,
      response: response as never,
    });

    expect(response.text).toHaveBeenCalledWith("User-agent: *\n");
  });

  it("case: failure (last-good kept) — a rejected regeneration leaves the previously published artifacts in place (full coverage: sitemap-lifecycle.spec.ts)", async () => {
    vi.resetModules();
    vi.doMock("./generate-sitemap", () => ({ generateSitemap: vi.fn() }));
    const generateSitemapMock = (await import("./generate-sitemap")).generateSitemap as ReturnType<
      typeof vi.fn
    >;
    const { getSitemapArtifacts, regenerateSitemap, resetSitemapLifecycleForTests } =
      await import("./sitemap-lifecycle");
    resetSitemapLifecycleForTests();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    generateSitemapMock.mockResolvedValueOnce({
      mode: "single",
      path: "/out/sitemap.xml",
      urls: 1,
      duplicates: [],
      routes: [],
    });
    await regenerateSitemap();
    const goodArtifacts = getSitemapArtifacts();

    generateSitemapMock.mockRejectedValueOnce(new Error("disk full"));
    await expect(regenerateSitemap()).rejects.toThrow("disk full");

    expect(getSitemapArtifacts()).toBe(goodArtifacts);

    vi.doUnmock("./generate-sitemap");
    vi.resetModules();
  });

  it("case: regeneration (join in-flight) — a second call while one is running joins the first instead of starting a new generation (full coverage: sitemap-lifecycle.spec.ts)", async () => {
    vi.resetModules();
    vi.doMock("./generate-sitemap", () => ({ generateSitemap: vi.fn() }));
    const generateSitemapMock = (await import("./generate-sitemap")).generateSitemap as ReturnType<
      typeof vi.fn
    >;
    const { regenerateSitemap, resetSitemapLifecycleForTests } =
      await import("./sitemap-lifecycle");
    resetSitemapLifecycleForTests();

    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    generateSitemapMock.mockImplementation(async () => {
      await gate;
      return { mode: "single", path: "/out/sitemap.xml", urls: 1, duplicates: [], routes: [] };
    });

    const first = regenerateSitemap();
    const second = regenerateSitemap();

    expect(generateSitemapMock).toHaveBeenCalledTimes(1);
    resolveGate();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);

    vi.doUnmock("./generate-sitemap");
    vi.resetModules();
  });
});
