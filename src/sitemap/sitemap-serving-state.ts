import type { SitemapGenerationManifest } from "@warlock.js/sitemap";
import type { SitemapArtifactStore } from "./sitemap-artifact-store";

/** The HTTP boundary reads published state and never triggers regeneration. */
export type SitemapServingState = {
  readonly store: SitemapArtifactStore;
  readonly cacheControl: string;
  readonly getManifest: () => Promise<SitemapGenerationManifest | undefined>;
};
