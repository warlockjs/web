import fs from "node:fs";
import path from "node:path";
import type { Router } from "@warlock.js/core";

export class InvalidProductionPublicFileError extends Error {
  public constructor(publicFile: string) {
    super(
      `Cannot register production public file ${JSON.stringify(publicFile)}: ` +
        "the build manifest must contain a non-empty relative POSIX path with no " +
        "traversal segments.",
    );
    this.name = "InvalidProductionPublicFileError";
  }
}

export class MissingProductionPublicFileError extends Error {
  public constructor(publicFile: string, absoluteFile: string) {
    super(
      `Cannot register production public file ${JSON.stringify(publicFile)}: ` +
        "the successful build manifest recorded it, but " +
        `${JSON.stringify(absoluteFile)} is missing or not a file. ` +
        "Run `warlock build` again to replace the incomplete artifact.",
    );
    this.name = "MissingProductionPublicFileError";
  }
}

function assertRelativePublicFile(publicFile: string): string[] {
  const segments = publicFile.split("/");

  if (
    publicFile.length === 0 ||
    publicFile.startsWith("/") ||
    publicFile.includes("\\") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new InvalidProductionPublicFileError(publicFile);
  }

  return segments;
}

/** Register the exact app-public files recorded by the successful build. */
export function registerProductionPublicFiles(
  router: Router,
  clientDir: string,
  publicFiles: readonly string[],
): void {
  const publicRoot = path.join(clientDir, "public");

  for (const publicFile of publicFiles) {
    const absoluteFile = path.join(publicRoot, ...assertRelativePublicFile(publicFile));

    let stat: fs.Stats;

    try {
      stat = fs.statSync(absoluteFile);
    } catch {
      throw new MissingProductionPublicFileError(publicFile, absoluteFile);
    }

    if (!stat.isFile()) {
      throw new MissingProductionPublicFileError(publicFile, absoluteFile);
    }

    router.file(`/${publicFile}`, absoluteFile);
  }
}
