import fs from "node:fs";
import path from "node:path";
import { parseRouteLocaleFile } from "./parse-route-locales";
import { assertRouteLocaleKeyOwnership } from "./route-locale-key-ownership";

type ParsedRouteLocaleFile = ReturnType<typeof parseRouteLocaleFile>;

export type RouteLocaleManifest = {
  localeCodes: readonly string[];
  localeCode: string;
  sources: readonly ParsedRouteLocaleFile[];
  keys: readonly string[];
  pages: Record<
    string,
    {
      sourceFiles: readonly string[];
      translationsByLocale: Record<string, Record<string, unknown>>;
    }
  >;
};

export type BuildRouteLocaleManifestOptions = {
  localeCodes?: readonly string[];
  localeCode?: string;
  /** Lets production hand the generated barrel's source text over without a filesystem read. */
  readSource?: (sourceFile: string) => string;
};

/** The filesystem identity both dev and the generated production barrel retain. */
export type RouteLocaleManifestGraph = {
  pages: readonly { pageFile: string; webRoot: string }[];
  localeFiles: readonly { sourceFile: string; webRoot: string }[];
};

const LOCALE_CODE = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/;

function validateLocaleConfiguration(options: BuildRouteLocaleManifestOptions): {
  localeCodes: string[];
  localeCode: string;
} {
  const { localeCodes, localeCode } = options;

  if (!Array.isArray(localeCodes) || localeCodes.length === 0) {
    throw new Error("Route locale files require a non-empty app.localeCodes configuration.");
  }
  if (typeof localeCode !== "string" || !LOCALE_CODE.test(localeCode)) {
    throw new Error(
      "Route locale files require app.localeCode to be a letters/digits/hyphen locale code.",
    );
  }

  const seen = new Set<string>();
  for (const code of localeCodes) {
    if (typeof code !== "string" || !LOCALE_CODE.test(code)) {
      throw new Error("app.localeCodes must contain only letters/digits/hyphen locale codes.");
    }
    if (seen.has(code))
      throw new Error(`app.localeCodes contains duplicate locale code ${JSON.stringify(code)}.`);
    seen.add(code);
  }
  if (!seen.has(localeCode)) {
    throw new Error(
      `app.localeCode ${JSON.stringify(localeCode)} is not present in app.localeCodes.`,
    );
  }

  return { localeCodes: [...localeCodes], localeCode };
}

function isWithin(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function sourceDepth(source: { sourceFile: string; webRoot: string }): number {
  const relative = path.relative(source.webRoot, path.dirname(source.sourceFile));
  return relative === "" ? 0 : relative.split(path.sep).length;
}

function compareSourceFiles(left: { sourceFile: string }, right: { sourceFile: string }): number {
  const leftPath = left.sourceFile.replaceAll("\\", "/");
  const rightPath = right.sourceFile.replaceAll("\\", "/");
  return leftPath === rightPath ? 0 : leftPath < rightPath ? -1 : 1;
}

function safeRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function assignNested(target: Record<string, unknown>, key: string, value: string): void {
  const segments = key.split(".");
  let cursor = target;

  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    if (existing === undefined) {
      const next = safeRecord<unknown>();
      cursor[segment] = next;
      cursor = next;
      continue;
    }
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
      throw new Error(`Route locale key ${JSON.stringify(key)} collides with a namespace prefix.`);
    }
    cursor = existing as Record<string, unknown>;
  }

  cursor[segments[segments.length - 1]!] = value;
}

/**
 * Turns the static locale-file graph into the route projections both dev and
 * production consume. It never loads an application module or reads global
 * config: callers supply locale settings and, in production, generated source
 * text through `readSource`.
 */
export function buildRouteLocaleManifest(
  graph: RouteLocaleManifestGraph,
  options: BuildRouteLocaleManifestOptions = {},
): RouteLocaleManifest | undefined {
  if (graph.localeFiles.length === 0) return undefined;

  const { localeCodes, localeCode } = validateLocaleConfiguration(options);
  const readSource =
    options.readSource ?? ((sourceFile: string) => fs.readFileSync(sourceFile, "utf8"));
  const sourceFiles = [...graph.localeFiles].sort((left, right) => {
    const depth = sourceDepth(left) - sourceDepth(right);
    return depth !== 0 ? depth : compareSourceFiles(left, right);
  });
  const sources = sourceFiles.map((source) =>
    parseRouteLocaleFile({
      sourceFile: source.sourceFile,
      webRoot: source.webRoot,
      source: readSource(source.sourceFile),
      localeCodes,
    }),
  );
  const keys = assertRouteLocaleKeyOwnership(sources);
  const pages = safeRecord<RouteLocaleManifest["pages"][string]>();

  for (const page of graph.pages) {
    const applicable = sources.filter(
      (source) =>
        source.webRoot === page.webRoot && isWithin(path.dirname(source.sourceFile), page.pageFile),
    );
    const translationsByLocale = safeRecord<Record<string, unknown>>();
    for (const code of localeCodes) translationsByLocale[code] = safeRecord<unknown>();

    for (const source of applicable) {
      for (const [key, translations] of Object.entries(source.entries)) {
        for (const code of localeCodes) {
          assignNested(translationsByLocale[code]!, key, translations[code]!);
        }
      }
    }

    pages[page.pageFile] = {
      sourceFiles: applicable.map((source) => source.sourceFile),
      translationsByLocale,
    };
  }

  return { localeCodes, localeCode, sources, keys, pages };
}
