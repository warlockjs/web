/**
 * The ONE runtime manifest read in production: one boot-time JSON
 * lookup of the `hydration` entry in `<clientDir>/.vite/manifest.json`,
 * producing the string `install-page-routes.ts:139` already accepts as
 * `hydrationClientModuleUrl`.
 *
 * NEVER FALLS BACK. Each failure is its own named error so the boot log says
 * which half of the build→runtime handoff broke: a missing
 * file means the client build never ran, malformed JSON means the artifact is
 * corrupt, and a missing entry means the build/runtime entry-name contract
 * drifted. "Serve without hydration" is not among the outcomes.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { HYDRATION_CLIENT_ENTRY_NAME } from "../vite/hydration-entries";
import { CLIENT_ASSET_URL_PREFIX } from "./client-asset-url-prefix";

export interface ResolveHydrationClientUrlOptions {
  /** Absolute path to the client build output dir: `<outdir>/client`. */
  clientDir: string;
}

/** The manifest file is absent — the client build never ran, or ran elsewhere. */
export class WebClientManifestMissingError extends Error {
  public constructor(manifestPath: string, cause: unknown) {
    super(
      `Cannot resolve the hydration client URL: the Vite client manifest "${manifestPath}" is missing or unreadable. ` +
        "This app was started in production without its `warlock build` client artifacts.",
      { cause },
    );
    this.name = "WebClientManifestMissingError";
  }
}

/** The manifest file exists but is not parsable JSON, or is not a JSON object. */
export class WebClientManifestMalformedError extends Error {
  public constructor(manifestPath: string, cause: unknown) {
    super(
      `Cannot resolve the hydration client URL: the Vite client manifest "${manifestPath}" is not valid JSON object content.`,
      { cause },
    );
    this.name = "WebClientManifestMalformedError";
  }
}

/**
 * The manifest parses but carries no usable `hydration` entry.
 *
 * The entry name is a shared contract between the build (`build-client.ts`
 * rollup input) and this runtime read; drift fails loudly HERE. Nobody adds a
 * default.
 */
export class WebClientManifestEntryMissingError extends Error {
  public constructor(manifestPath: string, entryName: string) {
    super(
      `Cannot resolve the hydration client URL: the Vite client manifest "${manifestPath}" has no "${entryName}" entry with a "file" string. ` +
        "The build and runtime hydration entry names have drifted.",
    );
    this.name = "WebClientManifestEntryMissingError";
  }
}

/**
 * The manifest names an entry file that does NOT live under the asset
 * directory `CLIENT_ASSET_URL_PREFIX` is mounted from.
 *
 * Serving it would 404 — the static route only exposes that one directory —
 * so the artifact is rejected at boot instead of at first page view.
 */
export class WebClientAssetPrefixViolationError extends Error {
  public constructor(manifestPath: string, file: string) {
    super(
      `Cannot resolve the hydration client URL: the Vite client manifest "${manifestPath}" points its entry at "${file}", ` +
        `which is not under the "${CLIENT_ASSET_URL_PREFIX}" asset directory this framework serves. ` +
        "This client artifact was not produced by this framework's client build configuration. " +
        "Re-run the client build instead of hand-editing the manifest or the build output.",
    );
    this.name = "WebClientAssetPrefixViolationError";
  }
}

type ManifestEntry = {
  file?: unknown;
  name?: unknown;
  isEntry?: unknown;
  imports?: unknown;
};

/**
 * Find the hydration entry in a parsed Vite manifest.
 *
 * VITE KEYS BY SOURCE PATH, NOT BY ENTRY NAME. A rollup input of
 * `{ hydration: "src/entry/index.ts" }` produces the record
 * `"src/entry/index.ts": { name: "hydration", isEntry: true, file: "assets/hydration-<hash>.js" }`
 * — the name the build and this module share lives in the `name` FIELD, and
 * there is no `"hydration"` key at all. Indexing the manifest by
 * {@link HYDRATION_CLIENT_ENTRY_NAME} therefore missed every real manifest and
 * reported an entry-name drift that had not happened.
 *
 * Matching on `isEntry` as well as `name` keeps this unambiguous: a shared
 * chunk can carry a `name` too, and only entries are addressable as a module
 * URL.
 */
function findHydrationEntry(
  manifest: Record<string, ManifestEntry | undefined>,
): ManifestEntry | undefined {
  for (const entry of Object.values(manifest)) {
    if (
      entry !== undefined &&
      typeof entry === "object" &&
      entry.isEntry === true &&
      entry.name === HYDRATION_CLIENT_ENTRY_NAME
    ) {
      return entry;
    }
  }

  return undefined;
}

export function resolveHydrationClientUrl(options: ResolveHydrationClientUrlOptions): string {
  const manifestPath = path.join(options.clientDir, ".vite", "manifest.json");

  let raw: string;

  try {
    raw = readFileSync(manifestPath, "utf-8");
  } catch (error) {
    throw new WebClientManifestMissingError(manifestPath, error);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new WebClientManifestMalformedError(manifestPath, error);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WebClientManifestMalformedError(
      manifestPath,
      new TypeError("The manifest root is not a JSON object."),
    );
  }

  const entry = findHydrationEntry(parsed as Record<string, ManifestEntry | undefined>);

  if (entry === undefined || typeof entry !== "object" || typeof entry.file !== "string") {
    throw new WebClientManifestEntryMissingError(manifestPath, HYDRATION_CLIENT_ENTRY_NAME);
  }

  const url = `/${entry.file}`;

  // The prefix is DERIVED from CLIENT_ASSET_URL_PREFIX, never restated: this
  // file must not carry a second copy of the literal the constant owns.
  if (!url.startsWith(`${CLIENT_ASSET_URL_PREFIX}/`)) {
    throw new WebClientAssetPrefixViolationError(manifestPath, entry.file);
  }

  // Past this point the returned URL starts with CLIENT_ASSET_URL_PREFIX by
  // construction — which is exactly what the static-file route mounting
  // `<clientDir>/assets` at that same imported symbol relies on.
  return url;
}

/**
 * The hydration entry's own STATICALLY imported chunks (`vendor-react`, most
 * of all — see `../vite/build-client.ts`'s `warlockHydrationManualChunks`),
 * as `modulepreload` URLs — card 53f8647e.
 *
 * WHY THIS EXISTS. Splitting React/ReactDOM/scheduler into their own chunk
 * (for a stable, deploy-independent cache key) means the browser now
 * discovers `vendor-react-<hash>.js` only after it has already fetched and
 * PARSED `hydration-<hash>.js` far enough to see the `import` statement —
 * one extra sequential round trip on every cold load, exactly the waterfall
 * the split must not cost. `<link rel="modulepreload">` fetches it in
 * parallel with the entry instead, so the split is a pure win, not the split
 * plus a round trip.
 *
 * WALKS `imports` ONLY, never `dynamicImports` — the same rule
 * `../server/stylesheet-urls.ts`'s `manifestStylesheetGraph` documents: a
 * STATIC import loads unconditionally alongside its importer, so preloading
 * it is always correct; a page's chunk is reached through a `dynamicImports`
 * entry (`page-registry-plugin.ts`'s per-page `import()`), and eagerly
 * preloading every page in the app on every request is the opposite of what
 * code-splitting bought.
 *
 * NEVER THROWS, unlike {@link resolveHydrationClientUrl}. A missing or
 * malformed manifest, or an entry with no `imports`, all mean "nothing extra
 * to preload" — the hydration script tag itself still loads the browser to
 * the entry correctly, so a preload-resolution failure must never be the
 * reason a page fails to render. `resolveHydrationClientUrl` already fails
 * loudly on exactly those manifest conditions, from the same boot path, and
 * runs first.
 */
export function resolveHydrationClientModulePreloadUrls(
  options: ResolveHydrationClientUrlOptions,
): string[] {
  const manifestPath = path.join(options.clientDir, ".vite", "manifest.json");

  let manifest: Record<string, ManifestEntry | undefined>;

  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];

    manifest = parsed as Record<string, ManifestEntry | undefined>;
  } catch {
    return [];
  }

  const entry = findHydrationEntry(manifest);
  if (entry === undefined) return [];

  const importedKeys = Array.isArray(entry.imports)
    ? entry.imports.filter((id): id is string => typeof id === "string")
    : [];

  const urls: string[] = [];
  const visited = new Set<string>();

  const visit = (key: string) => {
    if (visited.has(key)) return;
    visited.add(key);

    const node = manifest[key];
    if (node === undefined) return;

    if (typeof node.file === "string") {
      const url = `/${node.file}`;

      // Same servability rule as the entry URL itself and as
      // `stylesheet-urls.ts`'s `servableStylesheetUrls`: a preload target
      // outside the one directory the asset route mounts would 404, so it is
      // dropped rather than emitted.
      if (url.startsWith(`${CLIENT_ASSET_URL_PREFIX}/`) && !urls.includes(url)) {
        urls.push(url);
      }
    }

    if (Array.isArray(node.imports)) {
      for (const imported of node.imports) {
        if (typeof imported === "string") visit(imported);
      }
    }
  };

  for (const key of importedKeys) visit(key);

  return urls;
}
