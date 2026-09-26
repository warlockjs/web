import { existsSync } from "node:fs";
import path from "node:path";
import { toPosix } from "../shared/to-posix";

/** Stable Rollup/Vite entry name shared by development and production wiring. */
export const HYDRATION_CLIENT_ENTRY_NAME = "hydration";

export type HydrationClientEntry = Readonly<{
  name: typeof HYDRATION_CLIENT_ENTRY_NAME;
  sourcePath: string;
  devUrl: string;
}>;

/**
 * Where the hydration entry lives inside an INSTALLED `@warlock.js/web`, and
 * where it lives inside this checkout — in that order of preference.
 *
 * The published tarball ships `esm/`, `skills/` and the docs files — no `src/`
 * — so `src/` is absent from every real install. (Verified against
 * `@warlock.js/web@5.0.2`: 191 files, none under `src/`. Note the published
 * `package.json` carries no `files` key at all; the release tooling rewrites
 * the manifest, so do not treat this repo's `files` field as the mechanism.)
 * Resolving the entry to `<webRoot>/src/entry/index.ts` unconditionally
 * therefore worked in this monorepo and failed for every consumer, with
 * `warlock build` unable to emit a client bundle at all.
 *
 * The built artifact is preferred rather than the source being published,
 * because shipping `src/` beside `esm/` would put TWO instances of
 * `routing/route-table` in one client bundle — the app's own imports resolve
 * through `esm/`, the hydration entry's relative imports through `src/`.
 * `publishRouteTable()` would write to one and `<Link>` would read the other.
 */
const PACKAGED_ENTRY = "esm/entry/index.mjs";
const CHECKOUT_ENTRY = "src/entry/index.ts";

/**
 * Describes the single framework hydration entry without importing Vite.
 * Vite's `/@fs/` prefix accepts an absolute normalized file-system path;
 * keeping the drive colon produces `/@fs/D:/...` consistently on Windows.
 */
export function createHydrationClientEntry(webRoot: string): HydrationClientEntry {
  if (typeof webRoot !== "string" || webRoot.trim().length === 0) {
    throw new TypeError(
      "Cannot create the hydration client entry: webRoot must be a non-empty path.",
    );
  }

  const packagedPath = path.resolve(webRoot, PACKAGED_ENTRY);
  const sourcePath = toPosix(
    existsSync(packagedPath) ? packagedPath : path.resolve(webRoot, CHECKOUT_ENTRY),
  );

  return {
    name: HYDRATION_CLIENT_ENTRY_NAME,
    sourcePath,
    devUrl: `/@fs/${sourcePath}`,
  };
}

/** Query that tells the registry plugin which site's registry an entry's `virtual:warlock/pages` import means. */
export const HYDRATION_SITE_QUERY = "warlock-site";

/** Rollup entry name of one site's hydration entry: `hydration-<site>`. */
export function hydrationSiteEntryName(site: string): string {
  return `${HYDRATION_CLIENT_ENTRY_NAME}-${site}`;
}

/**
 * The site a hydration entry id was built for, or `undefined` for the plain
 * single-site entry. The id is the shared entry file plus `?warlock-site=<site>`,
 * so the ONE entry source is reused per site with its registry import
 * redirected by the plugin's `resolveId` rather than copied per site.
 */
export function siteOfHydrationEntryId(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  const queryStart = id.indexOf("?");
  if (queryStart === -1) return undefined;
  return new URLSearchParams(id.slice(queryStart + 1)).get(HYDRATION_SITE_QUERY) ?? undefined;
}

/** Rollup `input` for multi-site mode: `{ "hydration-<site>": <entry>?warlock-site=<site> }`. */
export function createHydrationSiteInputs(
  entry: HydrationClientEntry,
  sites: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    sites.map((site) => [
      hydrationSiteEntryName(site),
      `${entry.sourcePath}?${HYDRATION_SITE_QUERY}=${encodeURIComponent(site)}`,
    ]),
  );
}

type ClientManifestEntry = { name?: string; isEntry?: boolean; file?: string };

/**
 * The S3b seam: a site's emitted hydration asset (`assets/hydration-<site>-<hash>.js`,
 * relative to the client dir) read out of a parsed Vite client manifest
 * (`<clientDir>/.vite/manifest.json`), or `undefined` when the site has no entry.
 */
export function findSiteHydrationEntryFile(
  manifest: Record<string, ClientManifestEntry | undefined>,
  site: string,
): string | undefined {
  const name = hydrationSiteEntryName(site);
  for (const entry of Object.values(manifest)) {
    if (entry?.isEntry === true && entry.name === name && typeof entry.file === "string") {
      return entry.file;
    }
  }
  return undefined;
}
