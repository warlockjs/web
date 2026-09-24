import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { SitemapGenerationManifest } from "@warlock.js/sitemap";
import { SitemapArtifactStore } from "./sitemap-artifact-store";

const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");

class MemoryStorage {
  public readonly name = "local" as const;
  public readonly values = new Map<string, Buffer>();
  public failRead?: Error;
  public collideOnce = false;
  public async put(value: Buffer, location: string) {
    this.values.set(location, Buffer.from(value));
    return {};
  }
  public async putStream(stream: Readable, location: string) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    this.values.set(location, Buffer.concat(chunks));
    return {};
  }
  public async get(location: string) {
    if (this.failRead) throw this.failRead;
    const value = this.values.get(location);
    if (!value) throw new Error("Not found");
    return value;
  }
  public async getStream(location: string) {
    return Readable.from([await this.get(location)]);
  }
  public async list(directory: string) {
    const prefix = `${directory}/`;
    return [...this.values.keys()]
      .filter((location) => location.startsWith(prefix))
      .map((location) => ({
        path: location,
        name: location.slice(prefix.length),
        size: this.values.get(location)!.length,
        isDirectory: false,
      }));
  }
  public async metadata(location: string) {
    const value = await this.get(location);
    return {
      path: location,
      name: location.split("/").pop()!,
      size: value.length,
      isDirectory: false,
    };
  }
  public async delete(location: string) {
    return this.values.delete(location);
  }
  public supportsPutIfAbsent() {
    return true;
  }
  public async putIfAbsent(value: Buffer, location: string) {
    if (this.collideOnce || this.values.has(location)) {
      this.collideOnce = false;
      return null;
    }
    this.values.set(location, Buffer.from(value));
    return {};
  }
}

function manifest(
  file: Buffer,
  fence = 2,
  generationId = `run-${fence}`,
  generatedAt = "2026-09-24T12:34:56.000Z",
): SitemapGenerationManifest {
  return {
    version: 1,
    fence,
    generationId,
    coversRev: fence,
    kind: "single",
    mainFile: `generations/${generationId}/sitemap.xml`,
    files: [
      { path: `generations/${generationId}/sitemap.xml`, bytes: file.length, sha256: hash(file) },
    ],
    entries: 1,
    generatedAt,
  };
}

async function publish(store: SitemapArtifactStore, item: SitemapGenerationManifest, body: Buffer) {
  await store.writeArtifact({
    generationId: item.generationId,
    fileName: "sitemap.xml",
    body,
    bytes: body.length,
    sha256: hash(body),
  });
  await store.publishManifest(item);
}

describe("SitemapArtifactStore", () => {
  it("writes immutable artifacts and publishes a padded manifest object", async () => {
    const files = new MemoryStorage();
    const store = new SitemapArtifactStore(files as never, { storage: { directory: "sitemap" } });
    const body = Buffer.from("<urlset />");
    await publish(store, manifest(body), body);
    expect(files.values.has("sitemap/generations/run-2/sitemap.xml")).toBe(true);
    expect(files.values.has("sitemap/manifests/0000000000000002-run-2.json")).toBe(true);
  });

  it("ignores malformed or key/body-mismatched candidates and stream-verifies the next valid manifest", async () => {
    const files = new MemoryStorage();
    const messages: string[] = [];
    const store = new SitemapArtifactStore(files as never, {}, (message) => messages.push(message));
    const body = Buffer.from("current");
    await publish(store, manifest(body, 2), body);
    await files.put(
      Buffer.from(JSON.stringify(manifest(body, 1, "wrong"))),
      "sitemap/manifests/0000000000000003-mismatch.json",
    );
    await files.put(Buffer.from("partial"), "sitemap/manifests/0000000000000004-partial.json");
    await expect(store.readLatestManifest({ verifyFiles: true })).resolves.toMatchObject({
      fence: 2,
    });
    expect(messages.join(" ")).toMatch(/incomplete|does not match/);
  });

  it("does not hide storage authorization failures while reading candidates", async () => {
    const files = new MemoryStorage();
    const store = new SitemapArtifactStore(files as never);
    await files.put(Buffer.from("{}"), "sitemap/manifests/0000000000000001-run.json");
    files.failRead = new Error("access denied");
    await expect(store.readLatestManifest()).rejects.toThrow("access denied");
  });

  it("streams only artifacts retained by the requested generation manifest", async () => {
    const files = new MemoryStorage();
    const store = new SitemapArtifactStore(files as never);
    const body = Buffer.from("<urlset />");
    const current = manifest(body);
    await store.writeArtifact({
      generationId: current.generationId,
      fileName: "sitemap.xml",
      body,
      bytes: body.length,
      sha256: hash(body),
    });
    await expect(store.getArtifactStream(current, "generations/run-2/missing.xml")).rejects.toThrow(
      "not part",
    );
    const stream = await store.getArtifactStream(current, current.mainFile);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(body);
  });

  it("allocates durable fences through atomic create, relisting after a collision", async () => {
    const files = new MemoryStorage();
    files.collideOnce = true;
    const store = new SitemapArtifactStore(files as never);
    await expect(store.claimFence("run-claim")).resolves.toBe(1);
    expect(files.values.has("sitemap/fences/0000000000000001.json")).toBe(true);
  });

  it("refuses shared claims unless the selected store advertises atomic create", async () => {
    const files = new MemoryStorage();
    const store = new SitemapArtifactStore({
      ...files,
      supportsPutIfAbsent: undefined,
      putIfAbsent: undefined,
    } as never);
    expect(store.supportsSharedClaims()).toBe(false);
    await expect(store.claimFence("run-claim")).rejects.toThrow("putIfAbsent");
  });
  it("deletes only old validated manifests beyond the two newest global candidates", async () => {
    const files = new MemoryStorage();
    const store = new SitemapArtifactStore(files as never);
    const old = new Date(Date.now() - 60 * 60 * 1000 - 1).toISOString();
    const one = Buffer.from("one");
    const two = Buffer.from("two");
    const three = Buffer.from("three");
    const first = manifest(one, 1, "first", old);
    const second = manifest(two, 2, "second", old);
    const third = manifest(three, 3, "third", old);
    await publish(store, first, one);
    await publish(store, second, two);
    await publish(store, third, three);
    await expect(store.cleanupRetainedGenerations(third)).resolves.toEqual({
      manifests: 1,
      artifacts: 1,
    });
    expect(files.values.has("sitemap/manifests/0000000000000001-first.json")).toBe(false);
    expect(files.values.has("sitemap/generations/first/sitemap.xml")).toBe(false);
    expect(files.values.has("sitemap/manifests/0000000000000002-second.json")).toBe(true);
  });
});
