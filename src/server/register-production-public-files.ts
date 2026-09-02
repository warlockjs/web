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

/**
 * Seconds, not milliseconds — `Router.file`'s `cacheTime` is the response's
 * own `Cache-Control: max-age` value (`core/src/http/response.ts`), unlike
 * `@fastify/static`'s millisecond `maxAge`.
 *
 * These files are copied verbatim from `app/public` at build time: the URL is
 * the developer's chosen filename, not a content hash, so a rebuild can change
 * a file's bytes without changing its URL. `immutable` would tell the browser
 * to skip revalidation forever, which is wrong here — this is a plain
 * `max-age`, so a stale copy is served for at most this long and then
 * revalidated. Five minutes bounds staleness after a deploy to something a
 * developer would not notice, without paying a revalidation round trip on
 * every load the way `max-age=0` does.
 */
const PUBLIC_FILE_CACHE_MAX_AGE_SECONDS = 300;

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

    router.file(`/${publicFile}`, absoluteFile, PUBLIC_FILE_CACHE_MAX_AGE_SECONDS);
  }
}
