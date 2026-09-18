/**
 * `registerSitemapRoutes` — contract Part 4 rule 6 / Part B checklist item 1.
 * Handlers are invoked directly against a captured route table, never
 * through a real HTTP server: what matters here is what each handler DOES
 * with the lifecycle state, not Fastify's own dispatch.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpContext, Router } from "@warlock.js/core";

const { generateSitemap } = vi.hoisted(() => ({ generateSitemap: vi.fn() }));

vi.mock("./generate-sitemap", () => ({ generateSitemap }));

import { registerSitemapRoutes } from "./register-sitemap-routes";
import { regenerateSitemap, resetSitemapLifecycleForTests } from "./sitemap-lifecycle";

const temporaryDirectories: string[] = [];

function tempFile(contents: string | Buffer, fileName = "artifact.xml"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-sitemap-routes-"));
  temporaryDirectories.push(dir);
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, contents);

  return file;
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

function fakeResponse() {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, args: unknown[]) => {
    calls[name] = args;
  };

  const response: Record<string, (...args: unknown[]) => unknown> = {
    header: (...args: unknown[]) => {
      record("header", args);
      return response;
    },
    xml: (...args: unknown[]) => {
      record("xml", args);
      return response;
    },
    sendBuffer: (...args: unknown[]) => {
      record("sendBuffer", args);
      return response;
    },
    serviceUnavailable: (...args: unknown[]) => {
      record("serviceUnavailable", args);
      return response;
    },
    notFound: (...args: unknown[]) => {
      record("notFound", args);
      return response;
    },
  };

  return { response, calls };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe("registerSitemapRoutes", () => {
  beforeEach(() => {
    generateSitemap.mockReset();
    resetSitemapLifecycleForTests();
  });

  it("registers the configured path and both shard patterns", () => {
    const { router, routes } = capturingRouter();

    registerSitemapRoutes(router, { path: "/sitemap.xml" });

    expect(routes.has("/sitemap.xml")).toBe(true);
    expect(
      [...routes.keys()].some((key) => key.includes("(^sitemap") && key.endsWith(").xml")),
    ).toBe(true);
    expect(
      [...routes.keys()].some((key) => key.includes("(^sitemap") && key.endsWith(").xml.gz")),
    ).toBe(true);
  });

  it("serves 503 with Retry-After before the first generation, and never triggers one", async () => {
    const { router, routes } = capturingRouter();
    registerSitemapRoutes(router, { path: "/sitemap.xml", warn: () => undefined });

    const { response, calls } = fakeResponse();
    const mainHandler = routes.get("/sitemap.xml")!;

    await mainHandler({ request: { params: {} } as never, response: response as never });

    expect(calls.serviceUnavailable).toBeDefined();
    expect(calls.header).toEqual(["Retry-After", "30"]);
    expect(generateSitemap).not.toHaveBeenCalled();
  });

  it("serves the last-good bounded sitemap as XML, from disk, on every request", async () => {
    const file = tempFile("<urlset></urlset>");
    generateSitemap.mockResolvedValue({
      mode: "single",
      path: file,
      urls: 1,
      duplicates: [],
      routes: [],
    });
    await regenerateSitemap();
    generateSitemap.mockClear();

    const { router, routes } = capturingRouter();
    registerSitemapRoutes(router, { path: "/sitemap.xml" });

    const { response, calls } = fakeResponse();
    await routes.get("/sitemap.xml")!({
      request: { params: {} } as never,
      response: response as never,
    });

    expect(calls.xml).toEqual(["<urlset></urlset>"]);
    expect(generateSitemap).not.toHaveBeenCalled();
  });

  it("serves a known plain shard as XML and an unknown one as 404, without generating", async () => {
    const shard = tempFile("<urlset><shard/></urlset>", "sitemap-0001.xml");
    generateSitemap.mockResolvedValue({
      indexPath: tempFile("<sitemapindex></sitemapindex>", "sitemap_index.xml"),
      totalUrls: 1,
      duplicates: [],
      routes: [],
      files: [{ path: shard, urls: 1, bytes: 10, gzipped: false }],
    });
    await regenerateSitemap();
    generateSitemap.mockClear();

    const { router, routes } = capturingRouter();
    registerSitemapRoutes(router, { path: "/sitemap.xml" });
    const plainHandler = [...routes.entries()].find(([key]) => key.endsWith(").xml"))![1];

    const known = fakeResponse();
    await plainHandler({
      request: { params: { sitemapArtifactFile: "sitemap-0001" } } as never,
      response: known.response as never,
    });
    expect(known.calls.xml).toEqual(["<urlset><shard/></urlset>"]);

    const unknown = fakeResponse();
    await plainHandler({
      request: { params: { sitemapArtifactFile: "sitemap-9999" } } as never,
      response: unknown.response as never,
    });
    expect(unknown.calls.notFound).toBeDefined();
    expect(generateSitemap).not.toHaveBeenCalled();
  });

  it("serves a gzip shard with Content-Encoding: gzip and application/xml", async () => {
    const gz = tempFile(Buffer.from([0x1f, 0x8b, 0x00]), "sitemap-en-0001.xml.gz");
    generateSitemap.mockResolvedValue({
      indexPath: tempFile("<sitemapindex></sitemapindex>", "sitemap_index.xml"),
      totalUrls: 1,
      duplicates: [],
      routes: [],
      files: [{ path: gz, key: "en", urls: 1, bytes: 3, gzipped: true }],
    });
    await regenerateSitemap();
    generateSitemap.mockClear();

    const { router, routes } = capturingRouter();
    registerSitemapRoutes(router, { path: "/sitemap.xml" });
    const gzHandler = [...routes.entries()].find(([key]) => key.endsWith(").xml.gz"))![1];

    const { response, calls } = fakeResponse();

    await gzHandler({
      request: { params: { sitemapArtifactFile: "sitemap-en-0001" } } as never,
      response: response as never,
    });

    expect(calls.header).toEqual(["Content-Encoding", "gzip"]);
    expect(calls.sendBuffer?.[1]).toEqual({ contentType: "application/xml" });
    expect(generateSitemap).not.toHaveBeenCalled();
  });
});
