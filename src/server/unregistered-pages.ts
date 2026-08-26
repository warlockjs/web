import path from "node:path";
import {
  discoverPages,
  toPosix,
  type DiscoverPagesOptions,
  type DiscoveredPage,
} from "../build/discover-pages";
import { matchPath } from "./match-page-route";
import { isNotFoundPageFile } from "./not-found-page";

type DiscoveredGlobalPage = Pick<DiscoveredPage, "pageFile" | "routePath" | "webRoot">;
type DiscoverPages = (options: DiscoverPagesOptions) => readonly DiscoveredGlobalPage[];

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

function findUnregisteredPages(options: UnregisteredPagesOptions): DiscoveredGlobalPage[] {
  const { appRoot, appSrcRoot, registeredPageFiles, discover = discoverPages } = options;
  const registered = new Set(registeredPageFiles().map(fileKey));
  const webRoot = path.resolve(appSrcRoot, "web");

  return discover({ appRoot, srcDir: path.relative(appRoot, appSrcRoot) }).filter(
    (page) =>
      path.resolve(page.webRoot) === webRoot &&
      !isNotFoundPageFile(page.pageFile) &&
      !registered.has(fileKey(page.pageFile)),
  );
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

export function createUnregisteredPageReporter(
  options: UnregisteredPagesOptions,
): (request: { method: string; url: string; pathname: string }) => void {
  const { appRoot, warn = console.warn } = options;
  const reported = new Set<string>();

  return (request) => {
    // `discoverPages()` deliberately refuses malformed pages. Its install/build
    // diagnostic is authoritative, so a response hook must leave this 404 alone.
    try {
      const unregistered = findUnregisteredPages(options).find(
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
  };
}
