import fs from "node:fs";
import path from "node:path";

/**
 * Enumerate the application-owned files Vite serves from `<appRoot>/public`
 * in development. Paths are POSIX and relative so the same list can be baked
 * into the production page manifest without carrying a machine-local root.
 */
export async function collectPublicFiles(publicRoot: string): Promise<string[]> {
  let root: fs.Stats;

  try {
    root = await fs.promises.stat(publicRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  if (!root.isDirectory()) return [];

  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push(path.relative(publicRoot, absolute).split(path.sep).join("/"));
      }
    }
  }

  await visit(publicRoot);
  return files;
}

/** Copy exactly the files recorded by {@link collectPublicFiles}. */
export async function copyPublicFiles(
  publicRoot: string,
  outputRoot: string,
  files: readonly string[],
): Promise<void> {
  for (const file of files) {
    const segments = file.split("/");
    const source = path.join(publicRoot, ...segments);
    const target = path.join(outputRoot, ...segments);

    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.copyFile(source, target);
  }
}
