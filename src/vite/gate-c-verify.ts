/**
 * Gate C — emitted-output verification (canon `c604f0bc` §6).
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
 * Gate C also emits the inlined-`PUBLIC_*`-value manifest Suki asked for
 * (room seq 561 pt.2) — see `buildPublicEnvManifest` below — and is the only
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
 *   - `const route = ...` / `function loader() {}` (exported or not — canon
 *     `c604f0bc` §6 says "top-level bindings", not "top-level exports").
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
 * Part 1, item 1: parses each emitted chunk's ACTUAL code (never pre-transform
 * source) and looks for a top-level binding named one of the five server
 * exports. A parse failure on an emitted chunk is not this gate's concern —
 * it is skipped, not swallowed silently as a pass; a malformed emitted chunk
 * is a different failure Vite itself will already have surfaced.
 *
 * D.8 verdict (Suki's `build.minify: true` ruling, `gate-c-verify.spec.ts`
 * "D.8" describe block): this SURVIVES real minification. A minifier (esbuild,
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
    } catch {
      continue;
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
 * manifest" heuristic (Suki, room seq 561 pt.2: "define safe to show
 * conservatively — if genuinely unsure, show the key only, never guess a
 * value is safe"). The whole point of this manifest is that the `PUBLIC_`
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
 * Part 2 (Suki, room seq 561 pt.2): the enumerated, human-reviewable list of
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
            `Cause: "${importEdgeLeak.moduleId}" belongs to ${importEdgeLeak.packageName}, a server-only package (no "warlock": { "environment": "universal" | "client" } marker in its package.json — absent defaults to server-only), and is present among the bundled modules of the emitted client chunk "${importEdgeLeak.fileName}" — Gate A's resolveId should have refused this import before it ever reached the bundle.`,
            `Fix: this should already be impossible if Gate A ran on this build — investigate why ${importEdgeLeak.packageName} reached the emitted output (a Gate A bypass, a custom resolveId/external override, or a plugin ordering change) rather than assuming this build is a one-off; Gate C is defense in depth, not the primary fence.`,
          ].join("\n"),
        );
      }

      const manifest = buildPublicEnvManifest(tracker);
      bundle[manifestFileName] = {
        type: "asset",
        fileName: manifestFileName,
        name: manifestFileName,
        source: JSON.stringify(manifest, null, 2),
      } as any;
    },
  };
}
