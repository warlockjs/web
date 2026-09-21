import fs from "node:fs";
import path from "node:path";
import type { DiscoveredLocaleFile } from "./discover-pages";
import { parseRouteLocaleFile } from "./parse-route-locales";
import { assertRouteLocaleKeyOwnership } from "./route-locale-key-ownership";
import { toPosix } from "../shared/to-posix";

/** The build-to-runtime representation of a validated route-locales file. */
export type SerializedRouteLocaleFile = {
  sourceFile: string;
  webRoot: string;
  source: string;
};

/**
 * Reads each discovered locale file once, validates its source-only shape, and
 * turns its filesystem identities into the stable app-root-relative form used
 * by the generated production barrel.
 */
export function serializeRouteLocales(
  localeFiles: readonly DiscoveredLocaleFile[],
  appRoot: string,
): SerializedRouteLocaleFile[] {
  const serialized: SerializedRouteLocaleFile[] = [];
  const parsed = [];

  for (const localeFile of [...localeFiles].sort((left, right) => {
    const leftPath = toPosix(path.relative(appRoot, left.sourceFile));
    const rightPath = toPosix(path.relative(appRoot, right.sourceFile));
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  })) {
    const source = fs.readFileSync(localeFile.sourceFile, "utf-8");
    parsed.push(parseRouteLocaleFile({ ...localeFile, source }));
    serialized.push({
      sourceFile: toPosix(path.relative(appRoot, localeFile.sourceFile)),
      webRoot: toPosix(path.relative(appRoot, localeFile.webRoot)),
      source,
    });
  }

  assertRouteLocaleKeyOwnership(parsed);
  return serialized;
}
