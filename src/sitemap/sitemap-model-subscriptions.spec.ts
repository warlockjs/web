import { describe, expect, it, vi } from "vitest";
import { subscribeSitemapModels, type SitemapAfterCommit } from "./sitemap-model-subscriptions";
import type { SitemapModelLike } from "./sitemap-page-export";

function model(on: ReturnType<typeof vi.fn>): SitemapModelLike {
  return { events: () => ({ on }) } as SitemapModelLike;
}

describe("subscribeSitemapModels", () => {
  it("deduplicates models and loads afterCommit before registering listeners", async () => {
    const on = vi.fn(() => () => {});
    const loadAfterCommit = vi.fn(async () => ({ afterCommit: (() => {}) as SitemapAfterCommit }));
    const dependency = model(on);

    await subscribeSitemapModels([dependency, dependency], () => {}, { loadAfterCommit });

    expect(loadAfterCommit).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenNthCalledWith(1, "saved", expect.any(Function));
    expect(on).toHaveBeenNthCalledWith(2, "deleted", expect.any(Function));
  });

  it("defers invalidation until the registered afterCommit callback runs", async () => {
    const callbacks: Array<() => void> = [];
    const on = vi.fn((_event, listener: () => void) => {
      listener();
      return () => {};
    });
    const invalidate = vi.fn();

    await subscribeSitemapModels([model(on)], invalidate, {
      loadAfterCommit: async () => ({
        afterCommit: (callback: () => void) => callbacks.push(callback),
      }),
    });

    expect(invalidate).not.toHaveBeenCalled();
    callbacks.forEach((callback) => callback());
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("guards queued callbacks and removes listeners after disposal", async () => {
    const callbacks: Array<() => void> = [];
    const unsubscribe = vi.fn();
    const on = vi.fn((_event, listener: () => void) => {
      listener();
      return unsubscribe;
    });
    const invalidate = vi.fn();
    const subscriptions = await subscribeSitemapModels([model(on)], invalidate, {
      loadAfterCommit: async () => ({
        afterCommit: (callback: () => void) => callbacks.push(callback),
      }),
    });

    subscriptions.dispose();
    callbacks.forEach((callback) => callback());

    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("rolls back listeners registered before a partial subscription failure", async () => {
    const unsubscribe = vi.fn();
    const on = vi
      .fn()
      .mockReturnValueOnce(unsubscribe)
      .mockImplementationOnce(() => {
        throw new Error("deleted subscription failed");
      });

    await expect(
      subscribeSitemapModels([model(on)], () => {}, {
        loadAfterCommit: async () => ({ afterCommit: () => {} }),
      }),
    ).rejects.toThrow("deleted subscription failed");

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
