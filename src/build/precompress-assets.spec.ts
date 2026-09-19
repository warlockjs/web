/**
 * Red-first specs for {@link precompressAssets} — the build step that writes
 * `.br`/`.gz` siblings for the client bundle so production can serve
 * precompressed assets without compressing on every request (card `011315ae`).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { precompressAssets } from "./precompress-assets";

const temporaryDirectories: string[] = [];

function temporaryDirectory(name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), name));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe("precompressAssets", () => {
  it("writes .br and .gz siblings for a js file at least 1KB", async () => {
    const dir = temporaryDirectory("warlock-precompress-js-");
    const contents = "console.log('hydration');".repeat(100); // well over 1KB
    fs.writeFileSync(path.join(dir, "hydration-abc123.js"), contents, "utf-8");

    await precompressAssets(dir);

    expect(fs.existsSync(path.join(dir, "hydration-abc123.js.br"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "hydration-abc123.js.gz"))).toBe(true);

    const brotli = fs.readFileSync(path.join(dir, "hydration-abc123.js.br"));
    expect(zlib.brotliDecompressSync(brotli).toString("utf-8")).toBe(contents);

    const gzip = fs.readFileSync(path.join(dir, "hydration-abc123.js.gz"));
    expect(zlib.gunzipSync(gzip).toString("utf-8")).toBe(contents);
  });

  it("skips files smaller than 1KB", async () => {
    const dir = temporaryDirectory("warlock-precompress-small-");
    fs.writeFileSync(path.join(dir, "tiny.js"), "console.log(1);", "utf-8");

    await precompressAssets(dir);

    expect(fs.existsSync(path.join(dir, "tiny.js.br"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "tiny.js.gz"))).toBe(false);
  });

  it("skips non-text asset types even when large", async () => {
    const dir = temporaryDirectory("warlock-precompress-binary-");
    fs.writeFileSync(path.join(dir, "sprite.png"), Buffer.alloc(4096, 1), undefined);

    await precompressAssets(dir);

    expect(fs.existsSync(path.join(dir, "sprite.png.br"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "sprite.png.gz"))).toBe(false);
  });

  it("skips files that are already precompressed siblings", async () => {
    const dir = temporaryDirectory("warlock-precompress-already-");
    fs.writeFileSync(path.join(dir, "existing.js.br"), Buffer.alloc(4096, 1));
    fs.writeFileSync(path.join(dir, "existing.js.gz"), Buffer.alloc(4096, 1));

    await precompressAssets(dir);

    // no .br.br or .gz.gz double-compression siblings created
    expect(fs.existsSync(path.join(dir, "existing.js.br.br"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "existing.js.gz.gz"))).toBe(false);
  });

  it("recurses into nested directories, e.g. assets/chunks", async () => {
    const dir = temporaryDirectory("warlock-precompress-nested-");
    fs.mkdirSync(path.join(dir, "chunks"), { recursive: true });
    const contents = "body{color:red}".repeat(200);
    fs.writeFileSync(path.join(dir, "chunks", "vendor-def456.css"), contents, "utf-8");

    await precompressAssets(dir);

    expect(fs.existsSync(path.join(dir, "chunks", "vendor-def456.css.br"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "chunks", "vendor-def456.css.gz"))).toBe(true);
  });

  it("treats a missing directory as a no-op", async () => {
    const root = temporaryDirectory("warlock-precompress-missing-");

    await expect(precompressAssets(path.join(root, "assets"))).resolves.toBeUndefined();
  });
});
