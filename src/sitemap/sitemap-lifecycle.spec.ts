/**
 * Contract Part 6, rules 4-5: join-in-flight, last-good-on-failure,
 * unconditional stderr on a failed regeneration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { generateSitemap } = vi.hoisted(() => ({ generateSitemap: vi.fn() }));

vi.mock("./generate-sitemap", () => ({ generateSitemap }));

import {
  getLastSitemapFailure,
  getSitemapArtifacts,
  regenerateSitemap,
  resetSitemapLifecycleForTests,
} from "./sitemap-lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

describe("regenerateSitemap", () => {
  beforeEach(() => {
    generateSitemap.mockReset();
    resetSitemapLifecycleForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes a bounded result as the last-good artifact", async () => {
    generateSitemap.mockResolvedValue({
      mode: "single",
      path: "/out/sitemap.xml",
      urls: 3,
      duplicates: [],
      routes: [],
    });

    await regenerateSitemap();

    const artifacts = getSitemapArtifacts();
    expect(artifacts?.mainFile).toEqual({ absolutePath: "/out/sitemap.xml", gzipped: false });
    expect(artifacts?.shardFiles.size).toBe(0);
  });

  it("publishes an index result's shards, keyed by their served URL, skipping empty groups", async () => {
    generateSitemap.mockResolvedValue({
      indexPath: "/out/sitemap_index.xml",
      totalUrls: 2,
      duplicates: [],
      routes: [],
      files: [
        { path: "/out/sitemap-0001.xml", urls: 1, bytes: 100, gzipped: false },
        { path: "/out/sitemap-en-0001.xml.gz", key: "en", urls: 1, bytes: 50, gzipped: true },
        { path: "/out/sitemap-fr-0001.xml.gz", key: "fr", urls: 0, bytes: 0, gzipped: false },
      ],
    });

    await regenerateSitemap();

    const artifacts = getSitemapArtifacts();
    expect(artifacts?.mainFile).toEqual({ absolutePath: "/out/sitemap_index.xml", gzipped: false });
    expect(artifacts?.shardFiles.get("/sitemap-0001.xml")).toEqual({
      absolutePath: "/out/sitemap-0001.xml",
      gzipped: false,
    });
    expect(artifacts?.shardFiles.get("/sitemap-en-0001.xml.gz")).toEqual({
      absolutePath: "/out/sitemap-en-0001.xml.gz",
      gzipped: true,
    });
    expect(artifacts?.shardFiles.has("/sitemap-fr-0001.xml.gz")).toBe(false);
  });

  it("a disabled result publishes nothing", async () => {
    generateSitemap.mockResolvedValue({ mode: "disabled", urls: 0, duplicates: [], routes: [] });

    await regenerateSitemap();

    expect(getSitemapArtifacts()).toBeUndefined();
  });

  it("joins an in-flight generation instead of starting a second one", async () => {
    const gate = deferred<void>();
    generateSitemap.mockImplementation(async () => {
      await gate.promise;
      return { mode: "single", path: "/out/sitemap.xml", urls: 1, duplicates: [], routes: [] };
    });

    const first = regenerateSitemap();
    const second = regenerateSitemap();

    expect(generateSitemap).toHaveBeenCalledTimes(1);

    gate.resolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toBe(secondResult);
    expect(generateSitemap).toHaveBeenCalledTimes(1);
  });

  it("keeps the last good artifact and reports the error unconditionally when regeneration fails", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    generateSitemap.mockResolvedValueOnce({
      mode: "single",
      path: "/out/sitemap.xml",
      urls: 1,
      duplicates: [],
      routes: [],
    });
    await regenerateSitemap();
    const goodArtifacts = getSitemapArtifacts();

    const failure = new Error("disk full");
    generateSitemap.mockRejectedValueOnce(failure);

    await expect(regenerateSitemap()).rejects.toBe(failure);

    expect(getSitemapArtifacts()).toBe(goodArtifacts);
    expect(getLastSitemapFailure()?.error).toBe(failure);
    expect(stderr).toHaveBeenCalled();
  });

  it("a new call after a failure starts a fresh generation, not the failed in-flight promise", async () => {
    generateSitemap.mockRejectedValueOnce(new Error("boom"));
    await expect(regenerateSitemap()).rejects.toThrow("boom");

    generateSitemap.mockResolvedValueOnce({
      mode: "single",
      path: "/out/sitemap.xml",
      urls: 1,
      duplicates: [],
      routes: [],
    });
    await regenerateSitemap();

    expect(getSitemapArtifacts()?.mainFile.absolutePath).toBe("/out/sitemap.xml");
    expect(generateSitemap).toHaveBeenCalledTimes(2);
  });
});
