/** Storage-backed immutable sitemap generations; coordination and routes live elsewhere. */
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { LocalDriver, storage } from "@warlock.js/core";
import {
  parseSitemapGenerationManifest,
  sitemapManifestKey,
  sortSitemapManifestCandidates,
  type SitemapGenerationFile,
  type SitemapGenerationManifest,
  type SitemapManifestKey,
} from "@warlock.js/sitemap";

const DEFAULT_DIRECTORY = "sitemap";
const RETENTION_COUNT = 2;
const RETENTION_GRACE_MS = 60 * 60 * 1000;
const MAX_FENCE_CLAIM_ATTEMPTS = 32;
const FENCE_CLAIM_FILE = /^(\d{16})\.json$/;
const SAFE_DIRECTORY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type SitemapArtifactStoreConfig = {
  readonly storage?: { readonly disk?: string; readonly directory?: string };
  readonly legacyOutputDir?: string;
};
export type SitemapArtifactWrite = {
  readonly generationId: string;
  readonly fileName: string;
  readonly body: Buffer | Readable;
  readonly bytes: number;
  readonly sha256: string;
};
export type SitemapManifestReadOptions = { readonly verifyFiles?: boolean };
export type SitemapArtifactStoreDiagnostics = (message: string, error?: unknown) => void;
export type SitemapRetentionResult = { readonly manifests: number; readonly artifacts: number };

export class SitemapSharedClaimsUnsupportedError extends Error {
  public constructor() {
    super(
      "Shared sitemap generation requires storage with atomic putIfAbsent and consistent listing.",
    );
    this.name = "SitemapSharedClaimsUnsupportedError";
  }
}

export class SitemapFenceClaimContentionError extends Error {
  public constructor() {
    super(
      `Could not claim a sitemap generation fence after ${MAX_FENCE_CLAIM_ATTEMPTS} collisions.`,
    );
    this.name = "SitemapFenceClaimContentionError";
  }
}

type SitemapStorage = {
  readonly name: string;
  put(file: Buffer | string, location: string, options?: any): Promise<unknown>;
  putStream(stream: Readable, location: string, options?: any): Promise<unknown>;
  get(location: string): Promise<Buffer>;
  getStream(location: string): Promise<Readable>;
  list(
    directory: string,
  ): Promise<readonly { readonly name: string; readonly isDirectory: boolean }[]>;
  metadata(location: string): Promise<{ readonly size: number }>;
  delete(location: string): Promise<boolean>;
  supportsPutIfAbsent?: () => boolean;
  putIfAbsent?: (file: Buffer | string, location: string, options?: any) => Promise<unknown | null>;
};

function invalid(message: string): never {
  throw new TypeError(`Invalid sitemap artifact store configuration: ${message}`);
}
function safeDirectory(directory: string | undefined): string {
  const candidate = directory?.trim() || DEFAULT_DIRECTORY;
  const segments = candidate.split("/");
  if (
    candidate.startsWith("/") ||
    candidate.startsWith("\\") ||
    segments.length === 0 ||
    segments.some((part) => !SAFE_DIRECTORY_SEGMENT.test(part) || part === "." || part === "..")
  )
    return invalid("storage.directory must be a relative, traversal-free prefix.");
  return segments.join("/");
}
function safeFileName(fileName: string): string {
  if (
    !SAFE_FILE_NAME.test(fileName) ||
    fileName.includes("/") ||
    fileName === "." ||
    fileName === ".."
  )
    return invalid("artifact fileName must be a safe flat file name.");
  return fileName;
}
function safeNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    return invalid(`${label} must be a safe non-negative integer.`);
  return value;
}
function safeDigest(value: string): string {
  if (!SHA256.test(value))
    return invalid("artifact sha256 must be a lowercase SHA-256 hex digest.");
  return value;
}
function safeGenerationId(generationId: string): string {
  sitemapManifestKey(0, generationId);
  return generationId;
}
function compareIdentity(left: SitemapManifestKey, right: SitemapGenerationManifest): boolean {
  return left.fence === right.fence && left.generationId === right.generationId;
}
function isLower(left: SitemapGenerationManifest, right: SitemapGenerationManifest): boolean {
  return left.fence < right.fence;
}

/** Owns only objects below a dedicated sitemap prefix. */
export class SitemapArtifactStore {
  private readonly directory: string;

  public constructor(
    private readonly files: SitemapStorage,
    config: SitemapArtifactStoreConfig = {},
    private readonly report: SitemapArtifactStoreDiagnostics = (message, error) =>
      console.warn(`[warlock:web] ${message}`, error),
  ) {
    // Legacy outputDir itself was already the dedicated sitemap root.
    this.directory =
      config.legacyOutputDir === undefined ? safeDirectory(config.storage?.directory) : "";
  }

  public get driverName(): string {
    return this.files.name;
  }
  public artifactPath(generationId: string, fileName: string): string {
    return `generations/${safeGenerationId(generationId)}/${safeFileName(fileName)}`;
  }
  /** Whether this selected storage explicitly advertises atomic create support. */
  public supportsSharedClaims(): boolean {
    return (
      this.files.supportsPutIfAbsent?.() === true && typeof this.files.putIfAbsent === "function"
    );
  }

  /** Allocate a durable monotonically increasing shared fence. Claim files are never deleted. */
  public async claimFence(generationId: string): Promise<number> {
    const safeId = safeGenerationId(generationId);
    if (!this.supportsSharedClaims()) throw new SitemapSharedClaimsUnsupportedError();

    for (let attempt = 0; attempt < MAX_FENCE_CLAIM_ATTEMPTS; attempt++) {
      const fence = (await this.highestKnownFence()) + 1;
      const fileName = `${String(fence).padStart(16, "0")}.json`;
      const claimed = await this.files.putIfAbsent!(
        Buffer.from(JSON.stringify({ fence, generationId: safeId })),
        this.location(`fences/${fileName}`),
        { mimeType: "application/json" },
      );

      if (claimed !== null) return fence;
    }

    throw new SitemapFenceClaimContentionError();
  }

  public async writeArtifact(write: SitemapArtifactWrite): Promise<SitemapGenerationFile> {
    const path = this.artifactPath(write.generationId, write.fileName);
    const bytes = safeNonNegativeInteger(write.bytes, "artifact bytes");
    const sha256 = safeDigest(write.sha256);
    const options = { mimeType: "application/xml", metadata: { sha256, bytes: String(bytes) } };
    if (Buffer.isBuffer(write.body)) await this.files.put(write.body, this.location(path), options);
    else await this.files.putStream(write.body, this.location(path), options);
    return { path, bytes, sha256 };
  }

  /** Caller owns fencing; this writes a unique immutable manifest key and makes no CAS claim. */
  public async publishManifest(manifest: SitemapGenerationManifest): Promise<string> {
    const validated = parseSitemapGenerationManifest(manifest);
    const key = sitemapManifestKey(validated.fence, validated.generationId);
    await this.files.put(Buffer.from(JSON.stringify(validated)), this.location(key), {
      mimeType: "application/json",
      metadata: { sitemapManifestVersion: String(validated.version) },
    });
    return key;
  }

  public async readLatestManifest(
    options: SitemapManifestReadOptions = {},
  ): Promise<SitemapGenerationManifest | undefined> {
    for (const candidate of await this.manifestCandidates()) {
      const manifest = await this.readManifestCandidate(candidate);
      if (!manifest || (options.verifyFiles && !(await this.verifyArtifacts(manifest)))) continue;
      return manifest;
    }
    return undefined;
  }

  public async readManifestByGeneration(
    generationId: string,
    options: SitemapManifestReadOptions = {},
  ): Promise<SitemapGenerationManifest | undefined> {
    const safeId = safeGenerationId(generationId);
    for (const candidate of await this.manifestCandidates()) {
      if (candidate.generationId !== safeId) continue;
      const manifest = await this.readManifestCandidate(candidate);
      if (!manifest || (options.verifyFiles && !(await this.verifyArtifacts(manifest)))) continue;
      return manifest;
    }
    return undefined;
  }

  public async getArtifactStream(
    manifest: SitemapGenerationManifest,
    path: string,
  ): Promise<Readable> {
    const validated = parseSitemapGenerationManifest(manifest);
    if (!validated.files.some((file) => file.path === path))
      throw new TypeError("The requested sitemap artifact is not part of this manifest.");
    return this.files.getStream(this.location(path));
  }

  /** Delete only old, valid, owned manifests and their listed immutable artifacts. */
  public async cleanupRetainedGenerations(
    published: SitemapGenerationManifest,
    now = Date.now(),
  ): Promise<SitemapRetentionResult> {
    const caller = parseSitemapGenerationManifest(published);
    const candidates = await this.manifestCandidates();
    let manifests = 0;
    let artifacts = 0;

    for (const [index, candidate] of candidates.entries()) {
      if (index < RETENTION_COUNT) continue;
      const manifest = await this.readManifestCandidate(candidate);
      if (
        !manifest ||
        !isLower(manifest, caller) ||
        Date.parse(manifest.generatedAt) > now - RETENTION_GRACE_MS
      )
        continue;

      // Manifest first: a partial cleanup can only leave unreachable immutable files.
      await this.files.delete(this.location(candidate.key));
      manifests++;
      for (const artifact of manifest.files) {
        if (await this.files.delete(this.location(artifact.path))) artifacts++;
      }
    }

    return { manifests, artifacts };
  }

  private async highestKnownFence(): Promise<number> {
    const [claims, manifests] = await Promise.all([
      this.files.list(this.location("fences")),
      this.manifestCandidates(),
    ]);
    const claimFences = claims
      .filter((file) => !file.isDirectory)
      .map((file) => FENCE_CLAIM_FILE.exec(file.name)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number)
      .filter((fence) => Number.isSafeInteger(fence));
    return Math.max(0, ...claimFences, ...manifests.map((manifest) => manifest.fence));
  }
  private async manifestCandidates(): Promise<SitemapManifestKey[]> {
    const files = await this.files.list(this.location("manifests"));
    return sortSitemapManifestCandidates(
      files.filter((file) => !file.isDirectory).map((file) => `manifests/${file.name}`),
    );
  }

  private async readManifestCandidate(
    candidate: SitemapManifestKey,
  ): Promise<SitemapGenerationManifest | undefined> {
    let raw: Buffer;
    try {
      raw = await this.files.get(this.location(candidate.key));
    } catch (error) {
      if (this.isNotFound(error)) {
        this.report(
          `sitemap manifest ${candidate.key} disappeared before it could be read; ignoring candidate.`,
          error,
        );
        return undefined;
      }
      throw error;
    }
    try {
      const manifest = parseSitemapGenerationManifest(JSON.parse(raw.toString("utf8")));
      if (
        !compareIdentity(candidate, manifest) ||
        sitemapManifestKey(manifest.fence, manifest.generationId) !== candidate.key
      ) {
        this.report(
          `sitemap manifest ${candidate.key} does not match its immutable key; ignoring candidate.`,
        );
        return undefined;
      }
      return manifest;
    } catch (error) {
      this.report(
        `sitemap manifest ${candidate.key} is incomplete or invalid; ignoring candidate.`,
        error,
      );
      return undefined;
    }
  }

  private async verifyArtifacts(manifest: SitemapGenerationManifest): Promise<boolean> {
    for (const artifact of manifest.files) {
      try {
        const metadata = await this.files.metadata(this.location(artifact.path));
        if (metadata.size !== artifact.bytes) {
          this.report(`sitemap artifact ${artifact.path} size does not match its manifest.`);
          return false;
        }
        const digest = createHash("sha256");
        for await (const chunk of await this.files.getStream(this.location(artifact.path)))
          digest.update(chunk);
        if (digest.digest("hex") !== artifact.sha256) {
          this.report(`sitemap artifact ${artifact.path} digest does not match its manifest.`);
          return false;
        }
      } catch (error) {
        if (this.isNotFound(error)) {
          this.report(`sitemap artifact ${artifact.path} is missing; ignoring manifest.`, error);
          return false;
        }
        throw error;
      }
    }
    return true;
  }

  private location(relativePath: string): string {
    if (
      relativePath.startsWith("/") ||
      relativePath.includes("\\") ||
      relativePath.split("/").some((part) => part === "." || part === "..")
    )
      return invalid("storage object path must be a contained relative path.");
    return this.directory ? `${this.directory}/${relativePath}` : relativePath;
  }
  private isNotFound(error: unknown): boolean {
    return error instanceof Error && /not found|enoent|nosuchkey/i.test(error.message);
  }
}

/** Select a configured disk, the app default disk, or legacy local output at the exact legacy root. */
export function createSitemapArtifactStore(
  config: SitemapArtifactStoreConfig = {},
  dependencies: { readonly storage?: typeof storage } = {},
): SitemapArtifactStore {
  if (config.legacyOutputDir !== undefined)
    return new SitemapArtifactStore(new LocalDriver({ root: config.legacyOutputDir }), config);
  const manager = dependencies.storage ?? storage;
  return new SitemapArtifactStore(
    config.storage?.disk ? manager.use(config.storage.disk) : manager,
    config,
  );
}
