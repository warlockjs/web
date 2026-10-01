import path from "node:path";
import {
  LocaleDictionaryError,
  parseLocaleDictionary,
  type LocaleDictionaryEntries,
} from "@warlock.js/core";

export type RouteLocaleEntries = LocaleDictionaryEntries;

export type ParsedRouteLocaleFile = {
  sourceFile: string;
  webRoot: string;
  group: string;
  entries: RouteLocaleEntries;
};

const SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/** Compatibility alias for locale dictionary parse errors raised by the core parser. */
export { LocaleDictionaryError as RouteLocaleFileError };

function fail(sourceFile: string, key: string, detail: string): never {
  throw new LocaleDictionaryError(sourceFile, key, detail);
}

function assertNamespaceSegment(sourceFile: string, segment: string, key: string): void {
  if (!SEGMENT.test(segment)) fail(sourceFile, key, "segments must match [A-Za-z_][A-Za-z0-9_-]*");
  if (FORBIDDEN_SEGMENTS.has(segment)) fail(sourceFile, key, "segments cannot be reserved");
}

function namespaceFor(sourceFile: string, webRoot: string): string {
  const relativeDirectory = path.relative(webRoot, path.dirname(sourceFile));
  if (relativeDirectory === "") return "";
  if (relativeDirectory === ".." || relativeDirectory.startsWith(`..${path.sep}`)) {
    fail(sourceFile, "$group", "file is outside the web root");
  }
  const segments = withoutRouteOnlySegments(relativeDirectory.split(path.sep));
  for (const segment of segments) assertNamespaceSegment(sourceFile, segment, "$group");
  return segments.join(".");
}

/**
 * Drops folder segments that never reach the URL and so never name a
 * namespace: `(group)` and `[param]` folders, `$`-prefixed folders (`$sites`,
 * guard folders), and the site name that follows `$sites`.
 */
function withoutRouteOnlySegments(segments: readonly string[]): string[] {
  const kept: string[] = [];

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string;

    if (segment === "$sites") {
      index += 1;
      continue;
    }

    if (segment.startsWith("$")) continue;
    if (segment.startsWith("(") && segment.endsWith(")")) continue;
    if (segment.startsWith("[") && segment.endsWith("]")) continue;

    kept.push(segment);
  }

  return kept;
}

function assertFileWithinWebRoot(sourceFile: string, webRoot: string): void {
  const relativeFile = path.relative(webRoot, sourceFile);
  if (
    relativeFile === ".." ||
    relativeFile.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeFile)
  ) {
    fail(sourceFile, "$", "file is outside the web root");
  }
}

/** Parses one route-locales JSON source without reading the filesystem or loading application code. */
export function parseRouteLocaleFile(input: {
  sourceFile: string;
  webRoot: string;
  source: string;
  localeCodes?: readonly string[];
}): ParsedRouteLocaleFile {
  const { sourceFile, webRoot, source, localeCodes } = input;
  assertFileWithinWebRoot(sourceFile, webRoot);
  const parsed = parseLocaleDictionary({
    sourceFile,
    source,
    // Only derived when the file declares no `$group`.
    defaultNamespace: () => namespaceFor(sourceFile, webRoot),
    localeCodes,
  });
  return { ...parsed, webRoot };
}
