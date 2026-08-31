import fs from "node:fs";
import path from "node:path";

export const PAGE_FILE_SUFFIX = ".page.tsx";

export type PageFileChanges = {
  added: string[];
  removed: string[];
  inspectionNeeded: string[];
};

export type PageFileChangeOptions = {
  appRoot: string;
  appSrcRoot: string;
  installedPageFiles: readonly string[];
  fileExists?: (file: string) => boolean;
};

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function normalizePath(appRoot: string, file: string): string {
  return path.resolve(appRoot, file.replace(/[\\/]+/g, path.sep));
}

function pathKey(file: string): string {
  const normalized = file.replace(/\\/g, "/");

  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isPageFilePath(file: string, appSrcRoot: string): boolean {
  if (!file.endsWith(PAGE_FILE_SUFFIX)) {
    return false;
  }

  const relative = path.relative(appSrcRoot, file);

  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative) &&
    relative.split(path.sep)[0] === "web"
  );
}

/**
 * Layouts contribute to every descendant page's derived route identity, but
 * never own a route themselves. Keep this predicate aligned with
 * `page-registry-plugin.ts` so a layout lifecycle event re-derives the whole
 * page table rather than being discarded as an ordinary Vite update.
 */
export function isPageLayoutFilePath(file: string, appSrcRoot: string): boolean {
  const relative = path.relative(appSrcRoot, file);
  const base = path.basename(file);

  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative) &&
    relative.split(path.sep)[0] === "web" &&
    (base === "layout.ts" || base === "layout.tsx" || /\.layout\.tsx?$/.test(base))
  );
}

/** Error boundaries participate in reload tracking but never in router ownership. */
export function isErrorPageFilePath(file: string): boolean {
  return path.basename(file) === "error.page.tsx";
}

export function classifyPageFileChanges(
  changedFiles: readonly string[],
  options: PageFileChangeOptions,
): PageFileChanges {
  const pageRoot = path.resolve(options.appRoot, options.appSrcRoot);
  const installed = new Set(
    options.installedPageFiles.map((file) => pathKey(normalizePath(options.appRoot, file))),
  );
  const classified: PageFileChanges = { added: [], removed: [], inspectionNeeded: [] };
  const seen = new Set<string>();
  const fileExists = options.fileExists ?? isFile;

  for (const changedFile of changedFiles) {
    const file = normalizePath(options.appRoot, changedFile);
    const key = pathKey(file);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    // A layout has no individual router owner. Its addition, removal, or
    // in-place edit can change every descendant page's prefix/layout chain, so
    // force the existing full page-table derivation transaction. `added` is
    // deliberately the transaction's "replacement required" bucket here;
    // it does not claim the layout itself owns a newly-added route.
    if (isPageLayoutFilePath(file, pageRoot)) {
      (fileExists(file) ? classified.added : classified.removed).push(file);
      continue;
    }

    if (!isPageFilePath(file, pageRoot)) {
      continue;
    }

    const isInstalled = installed.has(key);
    const isErrorPage = isErrorPageFilePath(file);
    if (!fileExists(file)) {
      if (isInstalled || isErrorPage) {
        classified.removed.push(file);
      }
      continue;
    }

    if (isInstalled || isErrorPage) {
      classified.inspectionNeeded.push(file);
    } else {
      classified.added.push(file);
    }
  }

  return classified;
}

export function hasPageFileChanges(changes: PageFileChanges): boolean {
  return (
    changes.added.length > 0 ||
    changes.removed.length > 0 ||
    changes.inspectionNeeded.length > 0
  );
}
