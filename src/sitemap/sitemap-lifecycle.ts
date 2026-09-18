/**
 * The regeneration lifecycle (contract Part 6): joins a generation already in
 * flight instead of starting a second one, keeps serving the last good
 * artifact set on failure, and reports a failed run unconditionally.
 *
 * This module is the ONE place mutable "what does `/sitemap.xml` serve right
 * now" state lives. `./register-sitemap-routes.ts` only ever reads it; it
 * never calls {@link generateSitemap} itself (Part 6 rule 5 / rule 1 — a
 * request must never trigger generation).
 */
import path from "node:path";
import type { SitemapSetResult } from "@warlock.js/sitemap";
import { generateSitemap, type GenerateSitemapOptions } from "./generate-sitemap";
import type { SitemapResult } from "./sitemap-result-types";

export type SitemapGenerationResult = SitemapSetResult | SitemapResult;

export type SitemapArtifactFile = {
  readonly absolutePath: string;
  readonly gzipped: boolean;
};

/**
 * The last successfully published artifact set. `shardFiles` is keyed by the
 * URL path it is served at — always `/${basename}` at the site root, because
 * that is where `@warlock.js/sitemap` writes `<loc>` entries in the index
 * (`joinOrigin(baseUrl, file.fileName)`, no directory segment).
 */
export type SitemapArtifacts = {
  readonly mainFile: SitemapArtifactFile;
  readonly shardFiles: ReadonlyMap<string, SitemapArtifactFile>;
  readonly result: SitemapGenerationResult;
  readonly generatedAt: number;
};

export type SitemapFailure = {
  readonly error: unknown;
  readonly at: number;
};

let lastGood: SitemapArtifacts | undefined;
let lastFailure: SitemapFailure | undefined;
let inFlight: Promise<SitemapGenerationResult> | undefined;

function shardUrl(fileName: string): string {
  return `/${fileName}`;
}

function toArtifacts(result: SitemapGenerationResult): SitemapArtifacts | undefined {
  if ("indexPath" in result) {
    const shardFiles = new Map<string, SitemapArtifactFile>();

    for (const file of result.files) {
      // A zero-url row is reported, never written (`sitemap-shard-writer.ts`)
      // — nothing exists on disk at `file.path` to serve.
      if (file.urls === 0) continue;

      shardFiles.set(shardUrl(path.basename(file.path)), {
        absolutePath: file.path,
        gzipped: file.gzipped,
      });
    }

    return {
      mainFile: { absolutePath: result.indexPath, gzipped: false },
      shardFiles,
      result,
      generatedAt: Date.now(),
    };
  }

  if (result.mode === "disabled" || result.path === undefined) return undefined;

  return {
    mainFile: { absolutePath: result.path, gzipped: false },
    shardFiles: new Map(),
    result,
    generatedAt: Date.now(),
  };
}

/**
 * Generate (or join an already-running generation), publish the result as
 * the new last-good artifact set on success, and keep serving the previous
 * one on failure.
 *
 * The failure is reported to stderr UNCONDITIONALLY (canon `8d3c13a8`) —
 * this always fires, on top of anything the caller's own logging does,
 * because a fatal reported only through a configurable sink can vanish.
 */
export function regenerateSitemap(
  options: GenerateSitemapOptions = {},
): Promise<SitemapGenerationResult> {
  if (inFlight) return inFlight;

  const run = generateSitemap(options)
    .then((result) => {
      const artifacts = toArtifacts(result);
      if (artifacts) lastGood = artifacts;
      lastFailure = undefined;

      return result;
    })
    .catch((error: unknown) => {
      lastFailure = { error, at: Date.now() };
      console.error("[warlock:web] sitemap regeneration failed:", error);

      throw error;
    })
    .finally(() => {
      inFlight = undefined;
    });

  inFlight = run;

  return run;
}

/** The artifact set routes should serve, or `undefined` before the first successful generation. */
export function getSitemapArtifacts(): SitemapArtifacts | undefined {
  return lastGood;
}

export function getLastSitemapFailure(): SitemapFailure | undefined {
  return lastFailure;
}

/** Test-only: this module's state is a process-wide singleton by design (Part 6 rule 5). */
export function resetSitemapLifecycleForTests(): void {
  lastGood = undefined;
  lastFailure = undefined;
  inFlight = undefined;
}
