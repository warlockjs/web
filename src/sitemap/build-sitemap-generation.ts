/**
 * Produces one immutable sitemap candidate in an owned temporary directory.
 * Publication, storage drivers, manifests, leases, and lifecycle scheduling
 * deliberately live above this boundary.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SitemapSetResult } from "@warlock.js/sitemap";
import { generateSitemapArtifacts, type GenerateSitemapOptions } from "./generate-sitemap";
import { requireSitemapOrigin, type ResolvedSitemapConfig } from "./resolve-sitemap-config";
import type { SitemapModelLike } from "./sitemap-page-export";
import type { SitemapResult } from "./sitemap-result-types";

export type SitemapGenerationArtifact = {
  readonly path: string;
  readonly type: "index" | "sitemap";
  readonly gzipped: boolean;
  readonly count: number;
};

export type BuiltSitemapGeneration = {
  readonly stageDir: string;
  readonly mainFilePath: string;
  readonly artifactPaths: readonly string[];
  readonly artifacts: readonly SitemapGenerationArtifact[];
  readonly result: SitemapSetResult | SitemapResult;
  readonly models: readonly SitemapModelLike[];
  /** Removes only this call's `mkdtemp` root. Safe to call after publication. */
  readonly cleanup: () => Promise<void>;
};

export type BuildSitemapGenerationOptions = {
  readonly generationId: string;
  readonly resolvedConfig: ResolvedSitemapConfig;
  readonly options?: GenerateSitemapOptions;
};

const GENERATION_ID = /^[A-Za-z0-9_-]+$/;

function assertGenerationId(generationId: string): void {
  if (!GENERATION_ID.test(generationId)) {
    throw new TypeError(
      "Sitemap generationId must contain only letters, numbers, underscores, and hyphens.",
    );
  }
}

function artifactsFor(result: SitemapSetResult | SitemapResult): {
  readonly mainFilePath: string;
  readonly artifacts: readonly SitemapGenerationArtifact[];
} {
  if ("indexPath" in result) {
    return {
      mainFilePath: result.indexPath,
      artifacts: [
        { path: result.indexPath, type: "index", gzipped: false, count: result.totalUrls },
        ...result.files
          .filter((file) => file.urls > 0)
          .map((file) => ({
            path: file.path,
            type: "sitemap" as const,
            gzipped: file.gzipped,
            count: file.urls,
          })),
      ],
    };
  }

  if (result.mode === "single" && result.path) {
    return {
      mainFilePath: result.path,
      artifacts: [{ path: result.path, type: "sitemap", gzipped: false, count: result.urls }],
    };
  }

  throw new TypeError("Cannot stage a sitemap generation while web.sitemap.enabled is false.");
}

/**
 * Runs the existing generator against an isolated staging directory. The caller
 * receives only paths in that directory and must decide how, when, and where
 * to publish them.
 */
export async function buildSitemapGeneration(
  input: BuildSitemapGenerationOptions,
): Promise<BuiltSitemapGeneration> {
  const { generationId, resolvedConfig, options = {} } = input;

  assertGenerationId(generationId);

  if (!resolvedConfig.enabled) {
    throw new TypeError("Cannot stage a sitemap generation while web.sitemap.enabled is false.");
  }

  requireSitemapOrigin(resolvedConfig);

  const stageRoot = await mkdtemp(path.join(os.tmpdir(), "warlock-sitemap-"));

  try {
    const stageDir = path.join(stageRoot, generationId);
    const { legacyOutputDir: _legacyOutputDir, ...configWithoutLegacyOutput } = resolvedConfig;
    const stagedConfig: ResolvedSitemapConfig = {
      ...configWithoutLegacyOutput,
      // The configured HTTP path is independent of the stored representation.
      // Keep the single-file artifact XML even if that route ends in `.gz`.
      path: "/sitemap.xml",
      outputDir: stageDir,
    };
    const generated = await generateSitemapArtifacts(
      options,
      stagedConfig,
      `sitemaps/${generationId}`,
    );
    const { mainFilePath, artifacts } = artifactsFor(generated.result);

    return {
      stageDir,
      mainFilePath,
      artifactPaths: artifacts.map((artifact) => artifact.path),
      artifacts,
      result: generated.result,
      models: generated.models,
      cleanup: async () => rm(stageRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true });
    throw error;
  }
}
