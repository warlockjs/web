import type { SitemapModelLike } from "./sitemap-page-export";

export type SitemapAfterCommit = (callback: () => void) => void;

export type SitemapAfterCommitLoader = () => Promise<{
  readonly afterCommit?: unknown;
}>;

export type SitemapModelSubscriptionsDependencies = {
  readonly loadAfterCommit?: SitemapAfterCommitLoader;
};

export type SitemapModelSubscriptions = {
  readonly dispose: () => void;
};

export class SitemapAfterCommitUnavailableError extends Error {
  public constructor(cause?: unknown) {
    super(
      "Sitemap model invalidation requires @warlock.js/cascade afterCommit(). Install and configure @warlock.js/cascade, or remove sitemap.invalidateOn declarations.",
    );
    this.name = "SitemapAfterCommitUnavailableError";
    this.cause = cause;
  }
}

let sharedAfterCommitLoad: Promise<SitemapAfterCommit> | undefined;

function afterCommitFrom(module: { readonly afterCommit?: unknown }): SitemapAfterCommit {
  if (typeof module.afterCommit !== "function") throw new SitemapAfterCommitUnavailableError();

  return module.afterCommit as SitemapAfterCommit;
}

async function loadAfterCommit(
  loader: SitemapAfterCommitLoader | undefined,
): Promise<SitemapAfterCommit> {
  if (loader) {
    try {
      return afterCommitFrom(await loader());
    } catch (error) {
      if (error instanceof SitemapAfterCommitUnavailableError) throw error;
      throw new SitemapAfterCommitUnavailableError(error);
    }
  }

  sharedAfterCommitLoad ??= import("@warlock.js/cascade")
    .then(afterCommitFrom)
    .catch((error: unknown) => {
      if (error instanceof SitemapAfterCommitUnavailableError) throw error;
      throw new SitemapAfterCommitUnavailableError(error);
    });

  return sharedAfterCommitLoad;
}

/**
 * Subscribe once per declared model. Event handlers only queue the supplied
 * invalidation after Cascade confirms the surrounding transaction committed.
 */
export async function subscribeSitemapModels(
  models: readonly SitemapModelLike[],
  invalidate: () => void,
  dependencies: SitemapModelSubscriptionsDependencies = {},
): Promise<SitemapModelSubscriptions> {
  const uniqueModels = [...new Set(models)];
  if (uniqueModels.length === 0) return { dispose: () => {} };

  // This load happens before any listener registration. A missing optional
  // dependency cannot leave half a subscription set installed.
  const afterCommit = await loadAfterCommit(dependencies.loadAfterCommit);
  const unsubscribers: Array<() => void> = [];
  let disposed = false;

  const listener = (): void => {
    afterCommit(() => {
      if (!disposed) invalidate();
    });
  };

  try {
    for (const model of uniqueModels) {
      const events = model.events();
      unsubscribers.push(events.on("saved", listener));
      unsubscribers.push(events.on("deleted", listener));
    }
  } catch (error) {
    disposed = true;
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    throw error;
  }

  return {
    dispose: () => {
      if (disposed) return;

      disposed = true;
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    },
  };
}
