import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listRoutablePages } from "./list-routable-pages";

const temporaryDirectories: string[] = [];

function makeAppTree(files: Record<string, string>): string {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-list-routable-pages-"));
  temporaryDirectories.push(appRoot);

  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(appRoot, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf-8");
  }

  return appRoot;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe("listRoutablePages", () => {
  it("resolves each page's metadata and sitemap exports", async () => {
    const appRoot = makeAppTree({
      "src/web/about.page.tsx": [
        'export const metadata = { title: "About", robots: "noindex" };',
        "export default function Page() { return null; }",
      ].join("\n"),
      "src/web/posts/[id].page.tsx": [
        'export const sitemap = async () => [{ path: "/posts/hello-world" }];',
        "export default function Page() { return null; }",
      ].join("\n"),
    });

    const pages = await listRoutablePages({ appRoot });

    expect(pages).toHaveLength(2);

    const about = pages.find((page) => page.routePath === "/about");
    expect(about?.metadata).toEqual({ title: "About", robots: "noindex" });
    expect(about?.sitemap).toBeUndefined();

    const posts = pages.find((page) => page.routePath === "/posts/:id");
    expect(posts?.metadata).toBeUndefined();
    expect(typeof posts?.sitemap).toBe("function");
  });

  it("excludes the not-found route and the error page", async () => {
    const appRoot = makeAppTree({
      "src/web/home.page.tsx": [
        'export const route = "/";',
        "export default function Page() { return null; }",
      ].join("\n"),
      "src/web/404.page.tsx": "export default function Page() { return null; }",
      "src/web/error.page.tsx": "export default function ErrorPage() { return null; }",
    });

    const pages = await listRoutablePages({ appRoot });

    expect(pages).toHaveLength(1);
    expect(pages[0]?.routePath).toBe("/");
  });

  it("reports a page's explicit sitemap opt-out", async () => {
    const appRoot = makeAppTree({
      "src/web/draft.page.tsx": [
        "export const sitemap = false;",
        "export default function Page() { return null; }",
      ].join("\n"),
    });

    const pages = await listRoutablePages({ appRoot });

    expect(pages).toHaveLength(1);
    expect(pages[0]?.sitemap).toBe(false);
  });
});

/**
 * The DEV half of layout sitemap inheritance
 * (`contracts/layout-sitemap-and-robots-5.17.md`).
 *
 * Production's half is covered in `../sitemap/manifest-sitemap-page-source.spec.ts`.
 * Both halves need their own coverage precisely because they are the two
 * pipelines canon `b8e6ede3` is about: a test of one says nothing about the
 * other, and "it works in dev" is how every one of those defects was first
 * reported.
 */
describe("listRoutablePages — layout declarations", () => {
  it("carries each layout's `sitemap` export, outermost first", async () => {
    const appRoot = makeAppTree({
      // Renders nothing — a prefix-only layout. Two RENDERING layouts on one
      // path are refused, so this is also the realistic shape, and it proves a
      // non-rendering ancestor's declaration is still carried.
      "src/web/docs/layout.tsx": [
        'export const prefix = "/docs";',
        "export const sitemap = { priority: 0.2 };",
      ].join("\n"),
      "src/web/docs/api/layout.tsx": [
        "export const sitemap = false;",
        "export default function Layout() { return null; }",
      ].join("\n"),
      "src/web/docs/api/reference.page.tsx": ["export default function Page() { return null; }"].join(
        "\n",
      ),
    });

    const [page] = await listRoutablePages({ appRoot });

    expect(page?.layoutSitemaps?.map((layout) => layout.declared)).toEqual([
      { priority: 0.2 },
      false,
    ]);
  });

  it("reports a layout that declared nothing as `undefined`, keeping its position", async () => {
    // Order is load-bearing: the precedence rule takes the LAST declaration, so
    // a silent layout dropping out of the chain would hand the wrong
    // ancestor's policy to the page.
    const appRoot = makeAppTree({
      "src/web/shop/layout.tsx": ['export const prefix = "/shop";'].join("\n"),
      "src/web/shop/items/layout.tsx": [
        "export const sitemap = false;",
        "export default function Layout() { return null; }",
      ].join("\n"),
      "src/web/shop/items/list.page.tsx": [
        "export default function Page() { return null; }",
      ].join("\n"),
    });

    const [page] = await listRoutablePages({ appRoot });

    expect(page?.layoutSitemaps?.map((layout) => layout.declared)).toEqual([undefined, false]);
  });

  it("reports an empty chain for a page with no layouts, rather than omitting the field", async () => {
    const appRoot = makeAppTree({
      "src/web/plain.page.tsx": ["export default function Page() { return null; }"].join("\n"),
    });

    const [page] = await listRoutablePages({ appRoot });

    expect(page?.layoutSitemaps).toEqual([]);
  });
});
