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
 * Describes the single framework hydration entry without importing Vite.
 * Vite's `/@fs/` prefix accepts an absolute normalized file-system path;
 * keeping the drive colon produces `/@fs/D:/...` consistently on Windows.
 */
export function createHydrationClientEntry(webRoot: string): HydrationClientEntry {
  if (typeof webRoot !== "string" || webRoot.trim().length === 0) {
    throw new TypeError("Cannot create the hydration client entry: webRoot must be a non-empty path.");
  }

  const sourcePath = normalizeFileSystemPath(path.resolve(webRoot, "src/client/index.ts"));

  return {
    name: HYDRATION_CLIENT_ENTRY_NAME,
    sourcePath,
    devUrl: `/@fs/${sourcePath}`,
  };
}
