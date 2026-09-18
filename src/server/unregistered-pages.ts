import path from "node:path";
import {
  discoverPages,
  isDiscoveredRoutablePage,
  type DiscoverPagesOptions,
  type DiscoveredPage,
} from "../build/discover-pages";
import { matchPath } from "./match-page-route";
import { isNotFoundPageFile } from "./not-found-page";
import { toPosix } from "../shared/to-posix";

type DiscoveredGlobalPage = Extract<DiscoveredPage, { type: "page" }>;
type DiscoverPages = (options: DiscoverPagesOptions) => readonly DiscoveredPage[];

export type UnregisteredPagesOptions = {
  appRoot: string;
  appSrcRoot: string;
  registeredPageFiles: () => readonly string[];
  discover?: DiscoverPages;
  warn?: (message: string) => void;
};

function fileKey(file: string): string {
  const posix = toPosix(file);

  return process.platform === "win32" ? posix.toLowerCase() : posix;
}

/**
 * The filesystem walk alone — every routable global page on disk, filtered
 * only by facts that never change without a page file itself changing. What
 * is NOT applied here is the live registered-route diff: that depends on the
 * router table, which can change (a page going live, a restart) without a
 * single page file changing, so callers that cache this result must still
 * diff against `registeredPageFiles()` fresh on every call.
 */
function discoverGlobalPages(options: UnregisteredPagesOptions): DiscoveredGlobalPage[] {
  const { appRoot, appSrcRoot, discover = discoverPages } = options;
  const webRoot = path.resolve(appSrcRoot, "web");

  return discover({ appRoot, srcDir: path.relative(appRoot, appSrcRoot) })
    .filter(isDiscoveredRoutablePage)
    .filter((page) => path.resolve(page.webRoot) === webRoot && !isNotFoundPageFile(page.pageFile));
}

function findUnregisteredPages(options: UnregisteredPagesOptions): DiscoveredGlobalPage[] {
  const registered = new Set(options.registeredPageFiles().map(fileKey));

  return discoverGlobalPages(options).filter((page) => !registered.has(fileKey(page.pageFile)));
}

export function findUnregisteredPageFiles(options: UnregisteredPagesOptions): string[] {
  return findUnregisteredPages(options).map((page) => page.pageFile);
}

export function describeUnregisteredPages(
  pageFiles: readonly string[],
  appRoot: string,
  request: { method: string; url: string },
): string {
  const named = pageFiles
    .map((pageFile) => `  - ${toPosix(path.relative(appRoot, pageFile))}`)
    .join("\n");

  return (
    `[warlock:web] ${request.method} ${request.url} answered 404. ` +
    "These src/web page files exist on disk but are absent from the active route table:\n" +
    named
  );
}

export type UnregisteredPageReporter = ((request: {
  method: string;
  url: string;
  pathname: string;
}) => void) & {
  /**
   * Evicts the cached filesystem walk. Called from the existing dev page-file
   * watcher (`web-connector.ts`'s `classifyPageChanges`) whenever a page file
   * is added, removed or edited — never on a timer. The next unmatched
   * request re-walks and sees the change; every request before it reuses the
   * one snapshot below.
   */
  invalidateDiscovery: () => void;
};

/**
 * One 404 diagnostic reporter per dev boot, and ONE discovery snapshot for
 * its lifetime — arbitrary unmatched traffic (bots, favicon, typos) must not
 * re-run `discoverPages()`'s filesystem walk on every request. Because
 * `discover` is synchronous, a plain memo already gives concurrent misses the
 * "join one in-flight walk" property for free: JS has no interleaving point
 * inside a synchronous call, so two misses in the same tick can never both
 * observe an empty cache and both walk. A failed walk (`discover` throws)
 * leaves the cache unset — `snapshot` is only assigned after `discover`
 * returns — so the very next miss retries instead of caching the failure.
 */
export function createUnregisteredPageReporter(
  options: UnregisteredPagesOptions,
): UnregisteredPageReporter {
  const { appRoot, warn = console.warn } = options;
  const reported = new Set<string>();
  let snapshot: DiscoveredGlobalPage[] | undefined;

  function unregisteredPages(): DiscoveredGlobalPage[] {
    if (snapshot === undefined) {
      snapshot = discoverGlobalPages(options);
    }

    const registered = new Set(options.registeredPageFiles().map(fileKey));

    return snapshot.filter((page) => !registered.has(fileKey(page.pageFile)));
  }

  const report = ((request) => {
    // `discoverPages()` deliberately refuses malformed pages. Its install/build
    // diagnostic is authoritative, so a response hook must leave this 404 alone.
    try {
      const unregistered = unregisteredPages().find(
        (page) =>
          !reported.has(fileKey(page.pageFile)) &&
          matchPath(page.routePath, request.pathname) !== undefined,
      );

      if (unregistered === undefined) return;

      reported.add(fileKey(unregistered.pageFile));
      warn(describeUnregisteredPages([unregistered.pageFile], appRoot, request));
    } catch {
      return;
    }
  }) as UnregisteredPageReporter;

  report.invalidateDiscovery = () => {
    snapshot = undefined;
  };

  return report;
}
