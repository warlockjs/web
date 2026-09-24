/**
 * Local sitemap runtime assembly. It owns one process's staged generation and
 * immutable publication, but deliberately owns neither HTTP serving nor any
 * framework lifecycle registration.
 */
import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  GENERATION_MANIFEST_VERSION,
  parseSitemapGenerationManifest,
  type SitemapGenerationFile,
  type SitemapGenerationManifest,
} from "@warlock.js/sitemap";
import {
  buildSitemapGeneration,
  type BuildSitemapGenerationOptions,
  type BuiltSitemapGeneration,
} from "./build-sitemap-generation";
import { type GenerateSitemapOptions } from "./generate-sitemap";
import { type ResolvedSitemapConfig } from "./resolve-sitemap-config";
import { createSitemapArtifactStore, SitemapArtifactStore } from "./sitemap-artifact-store";
import {
  SitemapRegenerationCoordinator,
  type SitemapRegenerationErrorReporter,
} from "./sitemap-regeneration-coordinator";
import type { SitemapModelLike } from "./sitemap-page-export";
import type { SitemapResult } from "./sitemap-result-types";
import type { SitemapSetResult } from "@warlock.js/sitemap";

export type SitemapLocalRuntimeResult = {
  readonly manifest: SitemapGenerationManifest;
  /** The established generator result for callers that still consume it. */
  readonly result: SitemapSetResult | SitemapResult;
  readonly models: readonly SitemapModelLike[];
};

export type SitemapLocalRuntimePorts = {
  readonly store?: SitemapArtifactStore;
  readonly buildGeneration?: (
    input: BuildSitemapGenerationOptions,
  ) => Promise<BuiltSitemapGeneration>;
  readonly allocateFence?: (generationId: string) => Promise<number>;
  readonly createGenerationId?: () => string;
  readonly reportError?: SitemapRegenerationErrorReporter;
};

export type SitemapLocalRuntimeOptions = {
  readonly resolvedConfig: ResolvedSitemapConfig;
  readonly options?: GenerateSitemapOptions;
  readonly ports?: SitemapLocalRuntimePorts;
};

export class SitemapLocalRuntimeDisposedError extends Error {
  public constructor() {
    super("Sitemap local runtime has been disposed.");
    this.name = "SitemapLocalRuntimeDisposedError";
  }
}

async function streamHash(
  filePath: string,
): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const file = await stat(filePath);
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(filePath)) hash.update(chunk);

  return { bytes: file.size, sha256: hash.digest("hex") };
}

function durableResult(
  result: SitemapSetResult | SitemapResult,
  artifactPath: (stagedPath: string) => string,
): SitemapSetResult | SitemapResult {
  if ("indexPath" in result) {
    return {
      ...result,
      indexPath: artifactPath(result.indexPath),
      files: result.files.map((file) => ({ ...file, path: artifactPath(file.path) })),
    };
  }

  return result.mode === "single" && result.path
    ? { ...result, path: artifactPath(result.path) }
    : result;
}

/**
 * Builds into a private staging directory, writes immutable artifacts, and
 * only then publishes their manifest. Every request is serialized by the
 * coordinator so its result belongs to the caller's own pass.
 */
export class SitemapLocalRuntime {
  public readonly store: SitemapArtifactStore;
  private readonly resolvedConfig: ResolvedSitemapConfig;
  private readonly options: GenerateSitemapOptions | undefined;
  private readonly buildGeneration: (
    input: BuildSitemapGenerationOptions,
  ) => Promise<BuiltSitemapGeneration>;
  private readonly createGenerationId: () => string;
  private readonly reportError?: SitemapRegenerationErrorReporter;
  private readonly coordinator: SitemapRegenerationCoordinator<SitemapLocalRuntimeResult>;
  private initialized = false;
  private initialization?: Promise<void>;
  private disposed = false;
  private ownershipToken = 0;
  private fence = 0;
  private revisionBaseline = 0;
  private allocateFence: (generationId: string) => Promise<number>;
  private manifest?: SitemapGenerationManifest;

  public constructor(input: SitemapLocalRuntimeOptions) {
    this.resolvedConfig = input.resolvedConfig;
    this.options = input.options;
    this.store =
      input.ports?.store ??
      createSitemapArtifactStore({
        storage: input.resolvedConfig.storage,
        legacyOutputDir: input.resolvedConfig.legacyOutputDir,
      });
    this.buildGeneration = input.ports?.buildGeneration ?? buildSitemapGeneration;
    this.createGenerationId = input.ports?.createGenerationId ?? randomUUID;
    this.reportError = input.ports?.reportError;
    this.allocateFence =
      input.ports?.allocateFence ??
      (async (_generationId: string) => {
        this.fence++;
        return this.fence;
      });
    this.coordinator = new SitemapRegenerationCoordinator({
      run: (revision) => this.generate(revision),
      reportError: this.reportError,
    });
  }

  /** The last verified manifest adopted at boot or published by this runtime. */
  public get currentManifest(): SitemapGenerationManifest | undefined {
    return this.manifest;
  }

  /** Adopts the highest complete manifest and seeds this process's local sequence. */
  public async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initialization) return this.initialization;

    this.initialization = (async () => {
      const token = this.ownershipToken;
      const latest = await this.store.readLatestManifest({ verifyFiles: true });
      this.assertCurrent(token);

      this.manifest = latest;
      this.fence = latest?.fence ?? 0;
      this.revisionBaseline = latest?.coversRev ?? 0;
      this.initialized = true;
    })();

    try {
      await this.initialization;
    } finally {
      this.initialization = undefined;
    }
  }

  /** Requests a serialized, newly staged generation. */
  public async request(): Promise<SitemapLocalRuntimeResult> {
    await this.initialize();
    this.assertCurrent(this.ownershipToken);
    return this.coordinator.request();
  }

  /** Stops accepting or publishing work; an already running generator is not forcibly cancelled. */
  public dispose(): void {
    if (this.disposed) return;

    this.disposed = true;
    this.ownershipToken++;
    this.coordinator.dispose();
  }

  private async generate(revision: number): Promise<SitemapLocalRuntimeResult> {
    const token = this.ownershipToken;
    this.assertCurrent(token);
    const generationId = this.createGenerationId();
    const fence = await this.allocateFence(generationId);
    this.assertCurrent(token);
    let staged: BuiltSitemapGeneration | undefined;

    try {
      staged = await this.buildGeneration({
        generationId,
        resolvedConfig: this.resolvedConfig,
        ...(this.options === undefined ? {} : { options: this.options }),
      });
      this.assertCurrent(token);

      const files: SitemapGenerationFile[] = [];
      for (const artifactPath of staged.artifactPaths) {
        const { bytes, sha256 } = await streamHash(artifactPath);
        this.assertCurrent(token);
        files.push(
          await this.store.writeArtifact({
            generationId,
            fileName: path.basename(artifactPath),
            body: createReadStream(artifactPath),
            bytes,
            sha256,
          }),
        );
        this.assertCurrent(token);
      }

      const manifest = parseSitemapGenerationManifest({
        version: GENERATION_MANIFEST_VERSION,
        fence,
        generationId,
        coversRev: this.revisionBaseline + revision,
        kind: "indexPath" in staged.result ? "index" : "single",
        mainFile: this.store.artifactPath(generationId, path.basename(staged.mainFilePath)),
        files,
        entries: "indexPath" in staged.result ? staged.result.totalUrls : staged.result.urls,
        generatedAt: new Date().toISOString(),
      });
      const result = durableResult(staged.result, (artifactPath) =>
        this.store.artifactPath(generationId, path.basename(artifactPath)),
      );

      this.assertCurrent(token);
      await this.store.publishManifest(manifest);
      this.assertCurrent(token);
      this.manifest = manifest;

      return { manifest, result, models: staged.models };
    } finally {
      await staged?.cleanup();
    }
  }

  private assertCurrent(token: number): void {
    if (this.disposed || token !== this.ownershipToken)
      throw new SitemapLocalRuntimeDisposedError();
  }
}

export function createSitemapLocalRuntime(input: SitemapLocalRuntimeOptions): SitemapLocalRuntime {
  return new SitemapLocalRuntime(input);
}
