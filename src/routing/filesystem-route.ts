export type FilesystemRouteInput = {
  /** POSIX path relative to `src/web`, ending in `.page.tsx`. */
  pageFile: string;
  /** Layout prefixes keyed by their POSIX directory relative to `src/web`; root uses `""`. */
  layoutPrefixes?: Readonly<Record<string, string>>;
};

function isGroup(segment: string): boolean {
  return /^\([^/]+\)$/.test(segment);
}

function routeSegment(segment: string): string {
  const dynamic = /^\[([A-Za-z_][A-Za-z0-9_]*)\]$/.exec(segment);

  return dynamic ? `:${dynamic[1]}` : segment;
}

function prefixSegments(prefix: string): string[] {
  return prefix.split("/").filter(Boolean);
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
  const segments = [...prefixSegments(prefixes[""] ?? "")];

  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index];
    const directoryPath = directories.slice(0, index + 1).join("/");
    const prefix = prefixes[directoryPath];

    if (prefix !== undefined) {
      segments.push(...prefixSegments(prefix));
    } else if (!isGroup(directory)) {
      segments.push(routeSegment(directory));
    }
  }

  if (basename !== "index") {
    segments.push(routeSegment(basename));
  }

  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/** Derive the stable dotted route name from a page's filesystem identity. */
export function deriveFilesystemRouteName(pageFile: string): string {
  const { directories, basename } = pageParts(pageFile);
  const segments = directories.filter((segment) => !isGroup(segment)).map(routeSegment);

  if (basename !== "index") {
    segments.push(routeSegment(basename));
  }

  return segments.map((segment) => segment.replace(/^:/, "")).join(".") || "index";
}
