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

    if (seen.has(key) || !isPageFilePath(file, pageRoot)) {
      continue;
    }

    seen.add(key);

    const isInstalled = installed.has(key);
    if (!fileExists(file)) {
      if (isInstalled) {
        classified.removed.push(file);
      }
      continue;
    }

    if (isInstalled) {
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
