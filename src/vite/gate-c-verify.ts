/**
 * Gate C — emitted-output verification.
 *
 * Projection removes the five server exports before the client graph forms.
 * Gate A refuses forbidden import PATHS. Gate B refuses inline secret reads.
 * All three act BEFORE or DURING the build, on source or the module graph —
 * none of them ever looks at what actually came out the other end. Gate C
 * is that check: a build-time assertion on the EMITTED client bundle for
 * every page, verifying:
 *
 *   1. The emitted code contains none of the five server export names
 *      (`route`, `middleware`, `validation`, `loader`, `metadata`) as a
 *      top-level binding, exported or not — `findLeakedServerExports`.
 *   2. The emitted module graph (Rollup's `OutputBundle`, as seen in
 *      `generateBundle`) contains no import edge into a
 *      `warlock.environment: "server"` (or absent-defaulting-to-server)
 *      package — re-derived from the exact classifier Gate A uses
 *      (`gate-a-resolve.ts`'s `createEnvironmentClassifier`), never a second,
 *      independently-drifting classification scheme — `findLeakedServerImportEdges`.
 *
 * This is defense in depth: if projection or Gate A has a bug that lets
 * something through, Gate C is what turns "shipped a leak" into "build
 * fails." Both check functions are exported as PURE functions over a bundle
 * object precisely so a test can construct a bundle where projection/Gate A
 * are bypassed entirely (a hand-built leaked chunk, never produced by a real
 * pipeline run) and still prove Gate C catches it independently — re-running
 * the D.1-D.5 happy-path fixtures through the composed pipeline only proves
 * the happy path, never that Gate C itself has teeth.
 *
 * Gate C also emits the inlined-`PUBLIC_*`-value manifest — see
 * `buildPublicEnvManifest` below — and is the only
 * one of the three gates that runs exclusively at `generateBundle` time: it
 * has nothing to say about source, only about output.
 */
import { parse } from "@babel/parser";
import type { Plugin } from "vite";
import {
  createEnvironmentClassifier,
  type EnvironmentClassifier,
  type EnvironmentClassifierOptions,
} from "./gate-a-resolve";
import { createPublicEnvTracker, type PublicEnvTracker } from "./gate-b-secrets";
import { SERVER_EXPORT_NAMES } from "./projection";

export interface ServerExportLeak {
  fileName: string;
  exportName: string;
  line?: number;
}

export interface ServerImportEdgeLeak {
  fileName: string;
  moduleId: string;
  packageName: string;
}

export interface PublicEnvManifestEntry {
  key: string;
  /** `null` when `redacted` is true — see `isSafeToShowValue`. */
  value: string | null;
  redacted: boolean;
}

/**
 * A structurally-minimal view of Rollup's `OutputBundle` — only the fields
 * Gate C actually reads. Deliberately NOT the real `OutputBundle`/`OutputChunk`
 * types: Part 1's own discipline requires proving Gate C catches a bundle
 * that a real pipeline could never produce (a hand-built leaked chunk), and
 * forcing every test fixture to satisfy Rollup's full chunk shape would
 * fight that requirement for no safety benefit — Vite's real `generateBundle`
 * hook still hands Gate C a real `OutputBundle`, which is a structural
 * superset of this.
 */
type BundleLike = Record<
  string,
  {
    type?: string;
    fileName?: string;
    code?: string;
    moduleIds?: readonly string[];
  }
>;

/**
 * Recursively collects every top-level statement's bound name(s), matching:
 *   - `const route = ...` / `function loader() {}` (exported or not — the
 *     check is on top-level BINDINGS, not top-level exports).
 *   - `export const route = ...` / `export function loader() {}` (the
 *     `ExportNamedDeclaration` wrapper form).
 *   - `export { route }` (the bare re-export-specifier form Rollup sometimes
 *     emits instead of inlining the declaration itself).
 */
function collectServerExportNames(stmt: any): Array<{ name: string; line: number }> {
  const matches: Array<{ name: string; line: number }> = [];
  const line = stmt.loc?.start?.line as number | undefined;

  function record(name: string | undefined) {
    if (name && SERVER_EXPORT_NAMES.has(name)) matches.push({ name, line: line ?? 0 });
  }

  if (stmt.type === "VariableDeclaration") {
    for (const decl of stmt.declarations) {
      if (decl.id?.type === "Identifier") record(decl.id.name);
    }
  } else if (stmt.type === "FunctionDeclaration") {
    record(stmt.id?.name);
  } else if (stmt.type === "ExportNamedDeclaration") {
    if (stmt.declaration) matches.push(...collectServerExportNames(stmt.declaration));
    for (const specifier of stmt.specifiers ?? []) {
      record(specifier.exported?.name ?? specifier.exported?.value);
    }
  }

  return matches;
}

/**
 * Thrown when an emitted chunk cannot be parsed, which means Gate C could not
 * inspect it. A gate that skips what it cannot read reports "no violation
 * found" on precisely the input it failed to look at — the one input where
 * that answer is worthless. So an unreadable chunk fails the build instead.
 */
export class UnverifiableChunkError extends Error {
  readonly fileName: string;

  constructor(fileName: string, cause?: unknown) {
    super(
      [
        `Warlock stopped this build: a file in your client bundle could not be checked for server-only code.`,
        ``,
        `File: ${fileName}`,
        `Cause: this file could not be parsed as JavaScript, so the client/server boundary check could not be performed on it. Warlock cannot confirm that the server-only exports (route, middleware, validation, loader, metadata) were kept out of it.`,
        `Fix: the build is being stopped rather than passed, because a file that was never checked is not a file known to be safe. This emitted file is outside the JavaScript syntax Warlock can currently verify. Two things commonly put it there, and this error cannot tell which: the output uses syntax newer than the parser Warlock ships with, or a plugin or loader emitted non-standard syntax into the client bundle. Check the compatibility of whatever produced this file, then build again.`,
      ].join("\n"),
    );
    this.name = "UnverifiableChunkError";
    this.fileName = fileName;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Part 1, item 1: parses each emitted chunk's ACTUAL code (never pre-transform
 * source) and looks for a top-level binding named one of the five server
 * exports. A parse failure on an emitted chunk FAILS the gate
 * (`UnverifiableChunkError`) — it is never skipped. Skipping would report the
 * bundle clean on the one chunk the gate did not actually inspect, which is a
 * safety check failing open; a build stopped on an unreadable chunk is
 * recoverable, a boundary silently unenforced is not.
 *
 * This SURVIVES real minification (pinned by the `gate-c-verify.spec.ts`
 * "D.8" describe block). A minifier (esbuild,
 * Vite's default) is only free to rename LOCAL bindings; the exported name
 * itself is part of the module's public interface and is never mangled — a
 * minified `export const route = ...` still emits `export { e as route }`,
 * with the local identifier renamed (`e`) but `route` intact as the specifier's
 * `exported` name, which is exactly the field `collectServerExportNames`
 * reads for the `ExportNamedDeclaration` specifier form. No name-independent
 * redesign needed here — verified against a real `build.minify: true` output,
 * not assumed.
 */
export function findLeakedServerExports(bundle: BundleLike): ServerExportLeak[] {
  const leaks: ServerExportLeak[] = [];

  for (const file of Object.values(bundle)) {
    if (!file || file.type !== "chunk" || typeof file.code !== "string") continue;

    let ast: any;
    try {
      ast = parse(file.code, { sourceType: "module", plugins: ["typescript", "jsx"] });
    } catch (error) {
      throw new UnverifiableChunkError(file.fileName ?? "(unnamed chunk)", error);
    }

    for (const stmt of ast.program.body as any[]) {
      for (const match of collectServerExportNames(stmt)) {
        leaks.push({ fileName: file.fileName as string, exportName: match.name, line: match.line });
      }
    }
  }

  return leaks;
}

/**
 * Part 1, item 2: walks every emitted chunk's `moduleIds` (the resolved,
 * absolute file paths of every source module Rollup actually bundled into
 * that chunk) and classifies each one via the SAME `EnvironmentClassifier`
 * Gate A's `resolveId` uses, re-derived from `gate-a-resolve.ts` rather than
 * hand-rolled a second time. A moduleId that maps to a governed-scope
 * package classified `"server"` is an import edge Gate A should already
 * have refused — if it's here anyway, the earlier gate has a bug.
 *
 * D.8 verdict: this SURVIVES real minification unconditionally, and for a
 * stronger reason than item 1 above — it never reads emitted code text or
 * identifier names at all. `moduleIds` is Rollup's own bundling metadata
 * (which resolved source files ended up in this chunk), untouched by
 * minification, which only rewrites code, not that metadata. Verified
 * against a real `build.minify: true` output in `gate-c-verify.spec.ts`.
 */
export function findLeakedServerImportEdges(
  bundle: BundleLike,
  classifier: Pick<EnvironmentClassifier, "environmentOf" | "packageNameForFilePath">,
): ServerImportEdgeLeak[] {
  const leaks: ServerImportEdgeLeak[] = [];

  for (const file of Object.values(bundle)) {
    if (!file || file.type !== "chunk") continue;

    for (const moduleId of file.moduleIds ?? []) {
      const packageName = classifier.packageNameForFilePath(moduleId);
      if (!packageName) continue;
      if (classifier.environmentOf(packageName) === "server") {
        leaks.push({ fileName: file.fileName as string, moduleId, packageName });
      }
    }
  }

  return leaks;
}

/**
 * Conservative "does this PUBLIC_* value look safe to print in the reviewable
 * manifest" heuristic: if genuinely unsure, show the key only — never guess
 * that a value is safe. The whole point of this manifest is that the `PUBLIC_`
 * prefix rule alone is not trustworthy — someone can and will name an actual
 * secret `PUBLIC_STRIPE_KEY` — so a value that LOOKS like a credential is
 * redacted regardless of what its key is named. Non-string values (booleans,
 * numbers) are never secret-shaped and always shown.
 */
const CREDENTIALED_URL_RE = /:\/\/[^/\s]+:[^/\s@]+@/; // scheme://user:pass@host
const KNOWN_SECRET_PREFIX_RES = [
  /^sk_(live|test)_/i, // Stripe secret key (pk_ publishable is a different prefix)
  /^rk_(live|test)_/i, // Stripe restricted key
  /^AKIA[0-9A-Z]{12,}/, // AWS access key id
  /^gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub personal/OAuth/user/server tokens
  /^glpat-[A-Za-z0-9_-]{20,}/, // GitLab personal access token
  /^xox[baprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, // JWT (3 base64url segments)
];
// A long opaque token made up only of base64url/hex-ish characters, with both
// letters and digits, and no separators a human-authored public value (a
// URL, a short id) would normally contain — conservatively treated as a
// secret-shaped random token even though it might genuinely be safe.
const HIGH_ENTROPY_TOKEN_RE = /^[A-Za-z0-9+/_=-]{32,}$/;

function isSafeToShowValue(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return true;
  if (CREDENTIALED_URL_RE.test(value)) return false;
  if (KNOWN_SECRET_PREFIX_RES.some((re) => re.test(value))) return false;
  if (HIGH_ENTROPY_TOKEN_RE.test(value) && /[0-9]/.test(value) && /[a-zA-Z]/.test(value)) return false;
  return true;
}

function stringifyEnvValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "undefined";
}

/**
 * The enumerated, human-reviewable list of
 * every `PUBLIC_*` key actually inlined into the client bundle. Built
 * directly from `tracker.referencedKeys` — the exact same `Set` Gate B's own
 * `generateBundle` unread-key check (`gate-b-secrets.ts`) reads from — so
 * this manifest and that exclusion logic agree BY CONSTRUCTION: they are two
 * readers of one Set, not two independent recomputations of "which keys were
 * read" that could drift apart. A key only reaches `referencedKeys` once
 * `findViolation` in `gate-b-secrets.ts` has seen a statically-resolved
 * `import.meta.env.PUBLIC_X` read for it, which is also precisely the
 * condition under which Gate B allows its value to be inlined at all — an
 * unread key that somehow leaked in anyway is a Gate B `generateBundle`
 * BUILD FAILURE (see `gate-b-secrets.ts`), never silently listed here.
 */
export function buildPublicEnvManifest(tracker: PublicEnvTracker): PublicEnvManifestEntry[] {
  return [...tracker.referencedKeys]
    .sort()
    .map((key) => {
      const value = tracker.declaredEnv[key];
      const safe = isSafeToShowValue(value);
      return { key, value: safe ? stringifyEnvValue(value) : null, redacted: !safe };
    });
}

export interface GateCOptions extends EnvironmentClassifierOptions {
  /**
   * Shared with `gateBSecrets({ tracker })` — required for the manifest to
   * reflect what THIS build's Gate B pass actually saw. Defaults to a
   * private, unshared tracker (always empty) if omitted, which is only ever
   * correct when Gate C runs standalone in a test.
   */
  tracker?: PublicEnvTracker;
  /** Defaults to `"warlock-env-manifest.json"` (Suki's suggested name). */
  manifestFileName?: string;
}

/**
 * The client-build Vite plugin. Runs only at `generateBundle` — Gate C has
 * nothing to say about source, only about the bundle Rollup actually wrote.
 * Skipped for the SSR/server build, same as Gate B (`gate-b-secrets.ts`):
 * a page's server exports are meant to survive in that build; only the
 * client build is judged.
 */
export function gateCVerify(options: GateCOptions = {}): Plugin {
  const classifier = createEnvironmentClassifier(options);
  const tracker = options.tracker ?? createPublicEnvTracker();
  const manifestFileName = options.manifestFileName ?? "warlock-env-manifest.json";

  return {
    name: "warlock:gate-c-verify",
    generateBundle(_outputOptions, bundle) {
      if (this.environment?.config?.consumer === "server") return;

      const exportLeak = findLeakedServerExports(bundle)[0];
      if (exportLeak) {
        this.error(
          [
            `Gate C refused a build: a server export survived into the emitted client bundle.`,
            ``,
            `File: ${exportLeak.fileName}${exportLeak.line ? `:${exportLeak.line}` : ""}`,
            `Export: ${exportLeak.exportName}`,
            `Cause: "${exportLeak.exportName}" is one of the five server exports (route, middleware, validation, loader, metadata) and is still present as a top-level binding in the EMITTED client chunk — projection and/or Gate A should have removed or refused it before the bundle was written.`,
            `Fix: this should already be impossible if projection and Gate A ran correctly — investigate why "${exportLeak.exportName}" reached the emitted output (a projection bug, a build config that bypasses these plugins, or a plugin ordering change) rather than assuming this build is a one-off; Gate C is defense in depth, not the primary fence.`,
          ].join("\n"),
        );
      }

      const importEdgeLeak = findLeakedServerImportEdges(bundle, classifier)[0];
      if (importEdgeLeak) {
        this.error(
          [
            `Gate C refused a build: a server-only import edge survived into the emitted client bundle's module graph.`,
            ``,
            `File: ${importEdgeLeak.fileName}`,
            `Module: ${importEdgeLeak.moduleId}`,
            `Cause: "${importEdgeLeak.moduleId}" belongs to ${importEdgeLeak.packageName}, a server-only package (it declares "warlock": { "environment": "server" } in its package.json), and is present among the bundled modules of the emitted client chunk "${importEdgeLeak.fileName}" — Gate A's resolveId should have refused this import before it ever reached the bundle.`,
            `Fix: this should already be impossible if Gate A ran on this build — investigate why ${importEdgeLeak.packageName} reached the emitted output (a Gate A bypass, a custom resolveId/external override, or a plugin ordering change) rather than assuming this build is a one-off; Gate C is defense in depth, not the primary fence.`,
          ].join("\n"),
        );
      }

      const manifest = buildPublicEnvManifest(tracker);

      // EMITTED through `this.emitFile`, not written into `bundle` by hand.
      //
      // This used to assign a hand-built record directly:
      //
      //     bundle[manifestFileName] = { type: "asset", fileName, name, source } as any;
      //
      // and the `as any` was load-bearing, which was the warning sign. A Rollup
      // asset record carries `names` and `originalFileNames` ARRAYS; that object
      // had neither, so it was not the shape Rollup produces — it merely
      // type-asserted its way into the bundle.
      //
      // Nothing noticed until the production build got far enough to render
      // chunks, at which point Vite's own `vite:manifest` plugin read
      // `chunk.names.length` on every asset and died on `undefined`:
      //
      //     [vite:manifest] Cannot read properties of undefined (reading 'length')
      //
      // `emitFile` makes Rollup construct the record, so the shape is correct by
      // construction and stays correct when Rollup adds fields. Hand-building a
      // bundle entry is signing up to track someone else's internal type forever.
      this.emitFile({
        type: "asset",
        fileName: manifestFileName,
        source: JSON.stringify(manifest, null, 2),
      });
    },
  };
}
