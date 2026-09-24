import { describe, expect, it, vi } from "vitest";
import { createSitemapLocalRuntime } from "./sitemap-local-runtime";

describe("SitemapLocalRuntime", () => {
  it("adopts the highest verified manifest before its first fenced local request", async () => {
    const manifest = {
      version: 1 as const,
      fence: 7,
      generationId: "previous",
      coversRev: 12,
      kind: "single" as const,
      mainFile: "generations/previous/sitemap.xml",
      files: [{ path: "generations/previous/sitemap.xml", bytes: 1, sha256: "a".repeat(64) }],
      entries: 1,
      generatedAt: "2026-09-24T12:00:00.000Z",
    };
    const store = {
      readLatestManifest: vi.fn().mockResolvedValue(manifest),
      artifactPath: vi.fn((_id: string, fileName: string) => `generations/current/${fileName}`),
      writeArtifact: vi.fn().mockResolvedValue({
        path: "generations/current/sitemap.xml",
        bytes: 1,
        sha256: "b".repeat(64),
      }),
      publishManifest: vi.fn(),
    };
    const cleanup = vi.fn();
    const runtime = createSitemapLocalRuntime({
      resolvedConfig: { enabled: true } as never,
      ports: {
        store: store as never,
        allocateFence: vi.fn().mockResolvedValue(8),
        createGenerationId: () => "current",
        buildGeneration: vi.fn().mockResolvedValue({
          artifactPaths: [],
          mainFilePath: "sitemap.xml",
          result: { mode: "single", path: "sitemap.xml", urls: 1 },
          models: [],
          cleanup,
        }),
      },
    });

    await runtime.initialize();

    expect(runtime.currentManifest).toEqual(manifest);
    expect(store.readLatestManifest).toHaveBeenCalledWith({ verifyFiles: true });
  });
});
