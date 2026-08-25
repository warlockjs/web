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

type ManifestEntry = { file?: unknown; name?: unknown; isEntry?: unknown };

/**
 * Find the hydration entry in a parsed Vite manifest.
 *
 * VITE KEYS BY SOURCE PATH, NOT BY ENTRY NAME. A rollup input of
 * `{ hydration: "src/hydration/index.ts" }` produces the record
 * `"src/hydration/index.ts": { name: "hydration", isEntry: true, file: "assets/hydration-<hash>.js" }`
 * — the name the build and this module share lives in the `name` FIELD, and
 * there is no `"hydration"` key at all. Indexing the manifest by
 * {@link HYDRATION_CLIENT_ENTRY_NAME} therefore missed every real manifest and
 * reported an entry-name drift that had not happened.
 *
 * Matching on `isEntry` as well as `name` keeps this unambiguous: a shared
 * chunk can carry a `name` too, and only entries are addressable as a module
 * URL.
 */
function findHydrationEntry(manifest: Record<string, ManifestEntry | undefined>): ManifestEntry | undefined {
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
