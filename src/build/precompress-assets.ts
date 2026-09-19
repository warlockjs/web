/**
 * Writes `.br` and `.gz` precompressed siblings for the client build's
 * hashed assets (card `011315ae`) — so production can serve a precompressed
 * body instead of compressing every response on the fly.
 *
 * Called from `contribution.ts`'s `emit()` hook, right after
 * `buildWarlockHydrationClient` produces `<clientOutDir>/assets`. Kept as its
 * own module — a single-responsibility file, not folded into
 * `contribution.ts` or `public-files.ts` — because it is a pure filesystem
 * transform with no knowledge of the build context or the page graph.
 *
 * `@fastify/static`'s `preCompressed` option (see `../server/web-connector.ts`,
 * `productionAssetsDirectoryOptions`) is the consumer: it looks for exactly
 * this `<file>.br` / `<file>.gz` sibling layout next to the original.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * Extensions worth precompressing. Deliberately text/text-like formats only —
 * already-compressed binary formats (images, fonts, wasm, …) gain nothing
 * from a second compression pass and would just waste build time and disk.
 */
const PRECOMPRESSIBLE_EXTENSIONS = new Set([
  "js",
  "mjs",
  "css",
  "svg",
  "json",
  "html",
  "txt",
  "xml",
]);

/**
 * Below this, brotli/gzip framing overhead can outweigh the saving, and the
 * effort is not worth it. Matches `@fastify/static`'s own stated behavior of
 * "skip compression for smaller files that do not benefit from it".
 */
const MIN_PRECOMPRESS_SIZE_BYTES = 1024;

function isPrecompressedSibling(filename: string): boolean {
  return filename.endsWith(".br") || filename.endsWith(".gz");
}

function isEligibleAsset(filename: string, sizeInBytes: number): boolean {
  if (isPrecompressedSibling(filename)) return false;

  const extension = path.extname(filename).slice(1).toLowerCase();

  if (!PRECOMPRESSIBLE_EXTENSIONS.has(extension)) return false;

  return sizeInBytes >= MIN_PRECOMPRESS_SIZE_BYTES;
}

async function precompressFile(absolutePath: string): Promise<void> {
  const contents = await fs.promises.readFile(absolutePath);

  const brotli = zlib.brotliCompressSync(contents, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: contents.byteLength,
    },
  });
  await fs.promises.writeFile(`${absolutePath}.br`, brotli);

  const gzip = zlib.gzipSync(contents, { level: zlib.constants.Z_BEST_COMPRESSION });
  await fs.promises.writeFile(`${absolutePath}.gz`, gzip);
}

/**
 * Walks `directory` recursively and writes `.br`/`.gz` siblings for every
 * eligible asset (see {@link PRECOMPRESSIBLE_EXTENSIONS} and
 * {@link MIN_PRECOMPRESS_SIZE_BYTES}). A missing directory is a no-op —
 * a zero-page build produces no `assets/` directory at all, and this must
 * not fail that build.
 */
export async function precompressAssets(directory: string): Promise<void> {
  let root: fs.Stats;

  try {
    root = await fs.promises.stat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  if (!root.isDirectory()) return;

  async function visit(currentDirectory: string): Promise<void> {
    const entries = await fs.promises.readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
      const absolute = path.join(currentDirectory, entry.name);

      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }

      if (!entry.isFile()) continue;

      const stat = await fs.promises.stat(absolute);

      if (!isEligibleAsset(entry.name, stat.size)) continue;

      await precompressFile(absolute);
    }
  }

  await visit(directory);
}
