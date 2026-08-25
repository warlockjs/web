import { existsSync } from "node:fs";
import path from "node:path";

/** Stable Rollup/Vite entry name shared by development and production wiring. */
export const HYDRATION_CLIENT_ENTRY_NAME = "hydration";

export type HydrationClientEntry = Readonly<{
  name: typeof HYDRATION_CLIENT_ENTRY_NAME;
  sourcePath: string;
  devUrl: string;
}>;

function normalizeFileSystemPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/**
 * Where the hydration entry lives inside an INSTALLED `@warlock.js/web`, and
 * where it lives inside this checkout — in that order of preference.
 *
 * The published package declares `"files": ["esm"]`, so `src/` is absent from
 * every real install. Resolving the entry to `<webRoot>/src/hydration/index.ts`
 * unconditionally therefore worked in this monorepo and failed for every
 * consumer, with `warlock build` unable to emit a client bundle at all.
 *
 * The built artifact is preferred rather than the source being published,
 * because shipping `src/` beside `esm/` would put TWO instances of
 * `routing/route-table` in one client bundle — the app's own imports resolve
 * through `esm/`, the hydration entry's relative imports through `src/`.
 * `publishRouteTable()` would write to one and `<Link>` would read the other.
 */
const PACKAGED_ENTRY = "esm/hydration/index.mjs";
const CHECKOUT_ENTRY = "src/hydration/index.ts";

/**
 * Describes the single framework hydration entry without importing Vite.
 * Vite's `/@fs/` prefix accepts an absolute normalized file-system path;
 * keeping the drive colon produces `/@fs/D:/...` consistently on Windows.
 */
export function createHydrationClientEntry(webRoot: string): HydrationClientEntry {
  if (typeof webRoot !== "string" || webRoot.trim().length === 0) {
    throw new TypeError("Cannot create the hydration client entry: webRoot must be a non-empty path.");
  }

  const packagedPath = path.resolve(webRoot, PACKAGED_ENTRY);
  const sourcePath = normalizeFileSystemPath(
    existsSync(packagedPath) ? packagedPath : path.resolve(webRoot, CHECKOUT_ENTRY),
  );

  return {
    name: HYDRATION_CLIENT_ENTRY_NAME,
    sourcePath,
    devUrl: `/@fs/${sourcePath}`,
  };
}
