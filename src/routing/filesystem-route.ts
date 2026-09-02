import { PageFileSegmentNotSupportedError, classifyPageFileSegment } from "./page-file-segment";

export type FilesystemRouteInput = {
  /** POSIX path relative to `src/web`, ending in `.page.tsx`. */
  pageFile: string;
  /** Layout prefixes keyed by their POSIX directory relative to `src/web`; root uses `""`. */
  layoutPrefixes?: Readonly<Record<string, string>>;
};

function isGroup(segment: string): boolean {
  return /^\([^/]+\)$/.test(segment);
}

/**
 * Translate one filesystem segment (a directory name or the page basename)
 * into its route form. Consults {@link classifyPageFileSegment} first and
 * throws {@link PageFileSegmentNotSupportedError} for any segment outside
 * the supported grammar, naming `pageFile` for context, instead of silently
 * passing the segment through as a literal URL segment.
 */
function routeSegment(segment: string, pageFile: string): string {
  const verdict = classifyPageFileSegment(segment);

  if (verdict.type === "rejected") {
    throw new PageFileSegmentNotSupportedError(pageFile, segment, verdict.reason);
  }

  const dynamic = /^\[([A-Za-z_][A-Za-z0-9_]*)\]$/.exec(segment);

  return dynamic ? `:${dynamic[1]}` : segment;
}

function prefixSegments(prefix: string): string[] {
  return prefix.split("/").filter(Boolean);
}

/**
 * Split a layout `prefix` into route segments AND validate each one through
 * {@link routeSegment}, exactly like a directory segment. A `prefix` is
 * author-controlled text, not derived from the filesystem, so nothing about
 * it is exempt from the grammar `page-file-segment.ts` defines — without
 * this, a `prefix` such as `"/docs/[...slug]"` would smuggle a rejected
 * shape straight into the URL. `pageFile` identifies the page whose layout
 * contributed `prefix`, so a rejection points at the layout, not the page.
 */
function validatedPrefixSegments(prefix: string, pageFile: string): string[] {
  const source = `${pageFile} (via layout prefix '${prefix}')`;

  return prefixSegments(prefix).map((segment) => routeSegment(segment, source));
}

function pageParts(pageFile: string): { directories: string[]; basename: string } {
  if (pageFile.includes("\\")) {
    throw new Error(`filesystem-route: pageFile must use POSIX separators: "${pageFile}"`);
  }

  if (!pageFile.endsWith(".page.tsx")) {
    throw new Error(`filesystem-route: pageFile must end in .page.tsx: "${pageFile}"`);
  }

  const parts = pageFile.split("/");
  const filename = parts.pop() as string;

  return {
    directories: parts,
    basename: filename.slice(0, -".page.tsx".length),
  };
}

/** Derive the effective URL for a page with no explicit `route` export. */
export function deriveFilesystemRoutePath(input: FilesystemRouteInput): string {
  const { directories, basename } = pageParts(input.pageFile);
  const prefixes = input.layoutPrefixes ?? {};
  const segments = [...validatedPrefixSegments(prefixes[""] ?? "", input.pageFile)];

  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index];
    const directoryPath = directories.slice(0, index + 1).join("/");
    const prefix = prefixes[directoryPath];

    if (prefix !== undefined) {
      segments.push(...validatedPrefixSegments(prefix, input.pageFile));
    } else if (!isGroup(directory)) {
      segments.push(routeSegment(directory, input.pageFile));
    }
  }

  if (basename !== "index") {
    segments.push(routeSegment(basename, input.pageFile));
  }

  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/** Derive the stable dotted route name from a page's filesystem identity. */
export function deriveFilesystemRouteName(pageFile: string): string {
  const { directories, basename } = pageParts(pageFile);
  const segments = directories
    .filter((segment) => !isGroup(segment))
    .map((segment) => routeSegment(segment, pageFile));

  if (basename !== "index") {
    segments.push(routeSegment(basename, pageFile));
  }

  return segments.map((segment) => segment.replace(/^:/, "")).join(".") || "index";
}
