import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildRouteLocaleManifest,
  type RouteLocaleManifest,
  type RouteLocaleManifestGraph,
} from "../build/build-route-locale-manifest";
import {
  serializeRouteLocales,
  type SerializedRouteLocaleFile,
} from "../build/serialize-route-locales";
import { toPosix } from "../shared/to-posix";

type SerializedGraphPage = { pageFile: string; webRoot: string };

type DevRouteLocaleArtifact = {
  version: 1;
  pages: SerializedGraphPage[];
  localeFiles: SerializedRouteLocaleFile[];
};

export type PrepareDevRouteLocaleArtifactOptions = {
  graph: RouteLocaleManifestGraph;
  appRoot: string;
  artifactPath: string;
  localeCodes?: readonly string[];
  localeCode?: string;
};

export type PreparedDevRouteLocaleArtifact = {
  manifest: RouteLocaleManifest | undefined;
  commit(): void;
  dispose(): void;
};

function comparePaths(left: SerializedGraphPage, right: SerializedGraphPage): number {
  return left.pageFile === right.pageFile ? 0 : left.pageFile < right.pageFile ? -1 : 1;
}

function relativeIdentity(appRoot: string, file: string): string {
  return toPosix(path.relative(appRoot, file));
}

function resolveIdentity(appRoot: string, file: string): string {
  return path.resolve(appRoot, file);
}

/**
 * Stages the portable, raw-locale representation that development consumes.
 * The caller owns the commit boundary: a rejected route replacement can discard
 * this stage while the prior on-disk artifact remains intact.
 */
export function prepareDevRouteLocaleArtifact(
  options: PrepareDevRouteLocaleArtifactOptions,
): PreparedDevRouteLocaleArtifact {
  const artifactPath = path.resolve(options.artifactPath);
  const stagePath = `${artifactPath}.${process.pid}.${randomUUID()}.tmp`;
  let staged = false;

  try {
    const pages = options.graph.pages
      .map(({ pageFile, webRoot }) => ({
        pageFile: relativeIdentity(options.appRoot, pageFile),
        webRoot: relativeIdentity(options.appRoot, webRoot),
      }))
      .sort(comparePaths);
    const localeFiles = serializeRouteLocales(options.graph.localeFiles, options.appRoot);
    const artifact: DevRouteLocaleArtifact = { version: 1, pages, localeFiles };

    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    const stageFile = fs.openSync(stagePath, "wx");
    staged = true;
    try {
      fs.writeFileSync(stageFile, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
    } finally {
      fs.closeSync(stageFile);
    }

    // Read the staged bytes, rather than reusing the in-memory source strings:
    // dev and production therefore both assemble runtime snapshots from a raw
    // serialized source representation.
    const stagedArtifact = JSON.parse(
      fs.readFileSync(stagePath, "utf-8"),
    ) as DevRouteLocaleArtifact;
    const sources = new Map(
      stagedArtifact.localeFiles.map((source) => [
        resolveIdentity(options.appRoot, source.sourceFile),
        source.source,
      ]),
    );
    const manifest = buildRouteLocaleManifest(
      {
        pages: stagedArtifact.pages.map((page) => ({
          pageFile: resolveIdentity(options.appRoot, page.pageFile),
          webRoot: resolveIdentity(options.appRoot, page.webRoot),
        })),
        localeFiles: stagedArtifact.localeFiles.map((source) => ({
          sourceFile: resolveIdentity(options.appRoot, source.sourceFile),
          webRoot: resolveIdentity(options.appRoot, source.webRoot),
        })),
      },
      {
        localeCodes: options.localeCodes,
        localeCode: options.localeCode,
        readSource: (sourceFile) => {
          const source = sources.get(sourceFile);
          if (source === undefined) {
            throw new Error(
              `Route locale artifact has no source for ${JSON.stringify(sourceFile)}.`,
            );
          }
          return source;
        },
      },
    );

    return {
      manifest,
      commit() {
        if (!staged) return;
        fs.renameSync(stagePath, artifactPath);
        staged = false;
      },
      dispose() {
        if (!staged) return;
        fs.rmSync(stagePath, { force: true });
        staged = false;
      },
    };
  } catch (error) {
    if (staged) fs.rmSync(stagePath, { force: true });
    throw error;
  }
}
