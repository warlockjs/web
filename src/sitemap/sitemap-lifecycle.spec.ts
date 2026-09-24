import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  createStore: vi.fn(),
  createRuntime: vi.fn(),
  dependencies: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("./resolve-sitemap-config", () => ({ resolveSitemapConfig: mocks.config }));
vi.mock("./sitemap-artifact-store", () => ({ createSitemapArtifactStore: mocks.createStore }));
vi.mock("./sitemap-local-runtime", () => ({ createSitemapLocalRuntime: mocks.createRuntime }));
vi.mock("./collect-sitemap-entries", () => ({
  collectSitemapModelDependencies: mocks.dependencies,
}));
vi.mock("./sitemap-model-subscriptions", () => ({ subscribeSitemapModels: mocks.subscribe }));

import {
  getSitemapServingState,
  regenerateSitemap,
  refreshSitemapModelSubscriptions,
  resetSitemapLifecycleForTests,
  shutdownSitemapRuntime,
  startSitemapRuntime,
} from "./sitemap-lifecycle";

const manifest = (fence: number, generatedAt = "2026-09-24T12:00:00.000Z") => ({
  version: 1,
  fence,
  generationId: `run-${fence}`,
  coversRev: fence,
  kind: "single" as const,
  mainFile: `generations/run-${fence}/sitemap.xml`,
  files: [{ path: `generations/run-${fence}/sitemap.xml`, bytes: 1, sha256: "a".repeat(64) }],
  entries: 1,
  generatedAt,
});

function setup({ coordination = "local", onBoot = false } = {}) {
  const store = {
    supportsSharedClaims: vi.fn(() => coordination !== "shared"),
    readLatestManifest: vi.fn(),
    cleanupRetainedGenerations: vi.fn(async () => ({ manifests: 0, artifacts: 0 })),
    claimFence: vi.fn(),
  };
  const runtime = {
    store,
    currentManifest: undefined,
    initialize: vi.fn(),
    request: vi.fn(),
    dispose: vi.fn(),
  };
  mocks.config.mockReturnValue({
    enabled: true,
    storage: { directory: "sitemap" },
    legacyOutputDir: undefined,
    coordination,
    cacheControl: "public, max-age=300",
    manifestPollMs: 1,
    regenerateEveryMs: undefined,
    regenerate: { onBoot },
    locales: {},
  });
  mocks.createStore.mockReturnValue(store);
  mocks.createRuntime.mockReturnValue(runtime);
  mocks.dependencies.mockResolvedValue([]);
  mocks.subscribe.mockResolvedValue({ dispose: vi.fn() });
  return { store, runtime };
}

describe("managed sitemap lifecycle", () => {
  afterEach(async () => {
    await shutdownSitemapRuntime();
    vi.clearAllMocks();
  });

  it("restores and subscribes even when boot generation is disabled", async () => {
    const { runtime } = setup({ onBoot: false });
    await startSitemapRuntime();
    expect(runtime.initialize).toHaveBeenCalledOnce();
    expect(mocks.dependencies).toHaveBeenCalledOnce();
    expect(mocks.subscribe).toHaveBeenCalledOnce();
  });

  it("rejects shared mode before starting when storage cannot make atomic claims", async () => {
    setup({ coordination: "shared" });
    await expect(startSitemapRuntime()).rejects.toThrow("putIfAbsent");
    expect(mocks.createRuntime).not.toHaveBeenCalled();
  });

  it("adopts only a monotonically higher polled manifest and never generates from state reads", async () => {
    const { store } = setup();
    store.readLatestManifest.mockResolvedValueOnce(manifest(3)).mockResolvedValueOnce(manifest(2));
    await startSitemapRuntime();
    const state = getSitemapServingState()!;
    await expect(state.getManifest()).resolves.toMatchObject({ fence: 3 });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await expect(state.getManifest()).resolves.toMatchObject({ fence: 3 });
  });

  it("publishes the runtime result despite asynchronous cleanup failure", async () => {
    const { runtime, store } = setup();
    runtime.request.mockResolvedValue({
      manifest: manifest(1),
      result: { mode: "single", path: "x", urls: 1, duplicates: [], routes: [] },
    });
    store.cleanupRetainedGenerations.mockRejectedValue(new Error("cleanup"));
    await startSitemapRuntime();
    await expect(regenerateSitemap()).resolves.toMatchObject({ mode: "single" });
  });

  it("delegates overlapping manual requests to the runtime instead of retaining the legacy lifecycle join", async () => {
    const { runtime } = setup();
    runtime.request
      .mockResolvedValueOnce({
        manifest: manifest(1),
        result: { mode: "single", path: "first", urls: 1, duplicates: [], routes: [] },
      })
      .mockResolvedValueOnce({
        manifest: manifest(2),
        result: { mode: "single", path: "second", urls: 2, duplicates: [], routes: [] },
      });
    await startSitemapRuntime();

    const [first, second] = await Promise.all([regenerateSitemap(), regenerateSitemap()]);

    expect(runtime.request).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({ path: "first", urls: 1 });
    expect(second).toMatchObject({ path: "second", urls: 2 });
  });

  it("keeps the prior model subscriptions when a page-HMR replacement fails", async () => {
    setup();
    const old = { dispose: vi.fn() };
    mocks.subscribe
      .mockResolvedValueOnce(old)
      .mockRejectedValueOnce(new Error("new dependencies failed"));
    await startSitemapRuntime();
    await expect(refreshSitemapModelSubscriptions()).rejects.toThrow("new dependencies failed");
    expect(old.dispose).not.toHaveBeenCalled();
  });

  it("disposes a late replacement after shutdown instead of re-subscribing", async () => {
    setup();
    const old = { dispose: vi.fn() };
    let resolve!: (value: { dispose: ReturnType<typeof vi.fn> }) => void;
    const pending = new Promise<{ dispose: ReturnType<typeof vi.fn> }>((done) => {
      resolve = done;
    });
    const replacement = { dispose: vi.fn() };
    mocks.subscribe.mockResolvedValueOnce(old).mockReturnValueOnce(pending);
    await startSitemapRuntime();
    const refresh = refreshSitemapModelSubscriptions();
    await shutdownSitemapRuntime();
    resolve(replacement);
    await refresh;
    expect(replacement.dispose).toHaveBeenCalledOnce();
  });

  it("disposes runtime and subscriptions so queued handlers cannot survive shutdown", async () => {
    const { runtime } = setup();
    await startSitemapRuntime();
    await shutdownSitemapRuntime();
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(getSitemapServingState()).toBeUndefined();
  });
});
