/**
 * Gate A — `resolveId` refusal for the client build (canon `c604f0bc` §4).
 *
 * Resolution fails, with zero AST parsing, for import PATHS that can never be
 * client-safe:
 *   1. Node builtins (`fs`, `crypto`, `node:*`, ...).
 *   2. `@warlock.js/*` / `@mongez/*` packages whose `package.json` carries
 *      `"warlock": { "environment": "server" }`, OR carries no `warlock`
 *      marker at all — burden-inversion ruling (Suki, room seq 546): a
 *      package in either scope is presumed server-only unless it declares
 *      itself `"universal"` or `"client"`. Judged only for imports whose
 *      importer is inside the app root — see `isInsideAppRoot` note below.
 *   3. `*.server.ts` files / anything under a `.server/` directory.
 *   4. Local modules outside a `$module/web/` (or `src/web/`) folder that are
 *      not a recognized universal surface (`*.page.tsx`, `layout.tsx`,
 *      `src/web/App.tsx`).
 *
 * Gate B (inline secrets), Gate C (output verification) and the SSR mirror
 * rule (`*.client.*` refusal / `clientOnly()`) are NOT this gate — see
 * `c604f0bc` §5, §6 and the mirror-rule sentence in §4. Do not extend this
 * file to cover them; they are separate, later slices.
 */
import { builtinModules } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NODE_BUILTINS = new Set(builtinModules);

type WarlockEnvironment = "server" | "universal" | "client";

/**
 * Scopes governed by the burden-inversion marker ruling (room seq 546):
 * a package in either scope must declare `"warlock": { "environment": ... }`
 * to be anything other than server-only. Third-party packages outside these
 * two scopes (react, lodash, ...) are never asked for this field — they are
 * judged solely by Gate A's other, import-based rules.
 */
const GOVERNED_SCOPES = ["@warlock.js/", "@mongez/"];

function isGovernedScope(source: string): boolean {
  return GOVERNED_SCOPES.some((scope) => source.startsWith(scope));
}

/**
 * The package root of a scoped specifier, e.g. `@warlock.js/core/db` ->
 * `@warlock.js/core`, `@warlock.js/core` -> `@warlock.js/core`.
 */
function governedPackageNameOf(source: string): string {
  const [scope, name] = source.split("/");
  return `${scope}/${name}`;
}

interface WorkspaceIndex {
  /** Governed-scope workspace package name -> absolute `package.json` path. */
  packageJsonByName: Map<string, string>;
}

/**
 * Indexes every `@warlock.js/*` / `@mongez/*` workspace member's
 * `package.json` path from the monorepo root's `package.json` `workspaces`
 * array (`48cb4ae7` discipline — enumerated, never hand-typed). Walks up from
 * this file looking for the workspace root (identified by
 * `name: "warlock-workspace"`) so it works whether this module runs from
 * `web/src/vite/` (dev) or a compiled `web/esm/vite/` output. Returns
 * `undefined` when no monorepo root is reachable — e.g. this package
 * installed standalone in a consuming app — in which case governed packages
 * are located via `node_modules` instead (see `findNodeModulesPackageJson`).
 */
function findWorkspaceIndex(startDir: string): WorkspaceIndex | undefined {
  let dir = startDir;
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
        if (pkg?.name === "warlock-workspace" && Array.isArray(pkg.workspaces)) {
          const packageJsonByName = new Map<string, string>();
          for (const workspace of pkg.workspaces as string[]) {
            const workspacePkgPath = path.join(dir, workspace, "package.json");
            if (!existsSync(workspacePkgPath)) continue;
            try {
              const workspacePkg = JSON.parse(readFileSync(workspacePkgPath, "utf-8"));
              if (typeof workspacePkg.name === "string" && isGovernedScope(`${workspacePkg.name}/`)) {
                packageJsonByName.set(workspacePkg.name, workspacePkgPath);
              }
            } catch {
              // Unreadable workspace package.json — node_modules fallback still applies.
            }
          }
          return { packageJsonByName };
        }
      } catch {
        // Not the workspace root (or unreadable) — keep walking up.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Locates a governed-scope package's `package.json` the ordinary Node
 * resolution way — walking up `node_modules` directories from `startDir` —
 * for packages that are not monorepo workspace members (published
 * dependencies, e.g. `@mongez/reinforcements`, or any governed package when
 * this module runs standalone outside the monorepo).
 */
function findNodeModulesPackageJson(pkgName: string, startDir: string): string | undefined {
  let dir = startDir;
  for (let depth = 0; depth < 20; depth++) {
    const candidate = path.join(dir, "node_modules", pkgName, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function isNodeBuiltin(source: string): boolean {
  if (source.startsWith("node:")) return true;
  return NODE_BUILTINS.has(source);
}

function normalize(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function isServerFile(resolvedPath: string): boolean {
  const normalized = normalize(resolvedPath);
  // `.server` may or may not carry an extension by the time Gate A judges it
  // — a bare specifier like `./blog.server` (extension resolved later by
  // Vite) must be caught just as `./blog.server.ts` is.
  if (/\.server(\.[jt]sx?)?$/.test(normalized)) return true;
  if (/(^|\/)\.server(\/|$)/.test(normalized)) return true;
  return false;
}

function isRecognizedUniversalSurface(resolvedPath: string): boolean {
  const normalized = normalize(resolvedPath);
  const base = path.basename(normalized);
  if (/\.page\.tsx?$/.test(base)) return true;
  if (base === "layout.tsx" || base === "layout.ts") return true;
  if (normalized.endsWith("/src/web/App.tsx")) return true;
  return false;
}

function isWithinModuleWebFolder(resolvedPath: string): boolean {
  const normalized = normalize(resolvedPath);
  return /\/web\/[^/]+$/.test(normalized) || /\/web$/.test(normalized);
}

const LOCAL_MODULE_EXTENSIONS = /\.(tsx?|jsx?|mjs|cjs)$/;

/**
 * Rule 4 only judges local, code-carrying files resolved from a relative or
 * absolute specifier, INSIDE the app's own project root — package specifiers
 * are already covered by rules 1/2, non-code assets (css, images, ...) are
 * not the "server/client leak" shape this rule exists to catch, and a
 * dependency's own internal file layout (e.g. `@warlock.js/seal`'s
 * `src/rules/**`) is not organized by the `$module/web/` convention at all,
 * so judging it by that convention would fence out every third-party import.
 */
function isOutsideUniversalScope(source: string, resolvedPath: string, appRoot: string): boolean {
  const isRelativeOrAbsolute = source.startsWith(".") || path.isAbsolute(source);
  if (!isRelativeOrAbsolute) return false;
  if (!LOCAL_MODULE_EXTENSIONS.test(resolvedPath)) return false;
  if (!isInsideAppRoot(resolvedPath, appRoot)) return false;
  if (isWithinModuleWebFolder(resolvedPath)) return false;
  if (isRecognizedUniversalSurface(resolvedPath)) return false;
  return true;
}

function isInsideAppRoot(resolvedPath: string, appRoot: string): boolean {
  const relative = path.relative(appRoot, resolvedPath);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

interface FenceViolation {
  cause: string;
  fix: string;
}

function ruleViolation(
  source: string,
  resolvedPath: string,
  importer: string | undefined,
  environmentOf: (pkgName: string) => WarlockEnvironment,
  appRoot: string,
): FenceViolation | undefined {
  if (isNodeBuiltin(source)) {
    return {
      cause: `"${source}" is a Node.js builtin module and cannot run in the browser.`,
      fix: `Move the code that needs "${source}" into a *.server.ts file or a server-only loader/controller, and pass only serializable data to the client.`,
    };
  }

  // Rule 2 is judged only for imports whose importer is app-authored code
  // (inside `appRoot`) — mirroring rule 4's existing dependency-internals
  // exemption below. A governed package's OWN internal composition (e.g.
  // `@warlock.js/seal` importing `@mongez/reinforcements`) is that package's
  // business, not the app's; what Gate A polices is the app reaching INTO a
  // server-only package, not what a package it's already allowed to use does
  // internally.
  if (isGovernedScope(source) && (!importer || isInsideAppRoot(importer, appRoot))) {
    const pkgName = governedPackageNameOf(source);
    const environment = environmentOf(pkgName);
    if (environment === "server") {
      const scopeLabel = pkgName.startsWith("@warlock.js/") ? "@warlock.js" : "@mongez";
      return {
        cause: `"${source}" resolves into ${pkgName}, a server-only ${scopeLabel} package (no "warlock": { "environment": "universal" | "client" } marker in its package.json — absent defaults to server-only).`,
        fix: `Move this import behind a *.server.ts file, a loader, or a controller — the client only needs the serialized data it returns — or, if ${pkgName} is genuinely universal/client-safe, add "warlock": { "environment": "universal" } (or "client") to its package.json.`,
      };
    }
  }

  if (isServerFile(resolvedPath)) {
    return {
      cause: `"${source}" is a server-only file (matches *.server.ts or lives under a .server/ directory) and cannot be imported from client/universal code.`,
      fix: `Import the data this file produces through a loader instead of importing the server file directly, or move the shared logic into a universal helper under $module/web/.`,
    };
  }

  if (isOutsideUniversalScope(source, resolvedPath, appRoot)) {
    return {
      cause: `"${source}" lives outside this module's web/ folder and is not a recognized universal surface (*.page.tsx, layout.tsx, src/web/App.tsx, or a component under $module/web/).`,
      fix: `Move the file into $module/web/ (or src/web/), or export only the universal parts (types, seal schemas, pure helpers) from a location the client build can see.`,
    };
  }

  return undefined;
}

function displayName(id: string): string {
  return path.basename(id);
}

interface GateAOptions {
  /**
   * Force these governed-scope package names (e.g. `@warlock.js/core`) to
   * classify as `"server"` regardless of what `warlock.environment` their
   * `package.json` declares. Defaults to the live marker resolution (workspace
   * `package.json` lookup, falling back to `node_modules`). Only meant for
   * tests that need a deterministic classification independent of the host
   * filesystem.
   */
  serverPackages?: Iterable<string>;
  /**
   * The app's project root, for rule 4 ("outside `$module/web/`"). Only
   * local files resolved from INSIDE this root are judged by the
   * `$module/web/` convention — a dependency's own internal file layout
   * (reached once resolution has left the app root, e.g. via a monorepo
   * sibling or node_modules) is exempt from rule 4, though rules 1–3 still
   * apply to it. Defaults to `process.cwd()`, matching Vite's own default
   * `root`.
   */
  appRoot?: string;
}

/**
 * The client-build Vite plugin. `vite` is only imported for its types
 * (`import type`), so this module carries no runtime dependency on `vite`
 * being installed — it is a `peerDependenciesMeta.optional` peer.
 */
export function gateAResolve(options: GateAOptions = {}): Plugin {
  const forcedServerPackages = options.serverPackages ? new Set(options.serverPackages) : undefined;
  const appRoot = path.resolve(options.appRoot ?? process.cwd());
  const workspaceIndex = findWorkspaceIndex(__dirname);
  const environmentCache = new Map<string, WarlockEnvironment>();

  function environmentOf(pkgName: string): WarlockEnvironment {
    if (forcedServerPackages?.has(pkgName)) return "server";
    const cached = environmentCache.get(pkgName);
    if (cached) return cached;

    const packageJsonPath =
      workspaceIndex?.packageJsonByName.get(pkgName) ?? findNodeModulesPackageJson(pkgName, appRoot);

    let environment: WarlockEnvironment = "server";
    if (packageJsonPath) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
        const marker = pkg?.warlock?.environment;
        if (marker === "universal" || marker === "client") environment = marker;
      } catch {
        // Unreadable package.json — the burden-inversion default (server) applies.
      }
    }

    environmentCache.set(pkgName, environment);
    return environment;
  }

  // Maps a resolved module id to the id that imported it, rebuilt per plugin
  // instance (i.e. per build) via our own `this.resolve` calls below — this
  // does not depend on Rollup's internal module-graph bookkeeping being
  // populated in any particular order.
  const importerOf = new Map<string, string>();

  function buildChain(importer: string | undefined): string[] {
    const chain: string[] = [];
    let current = importer;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      chain.unshift(displayName(current));
      current = importerOf.get(current);
    }
    return chain;
  }

  return {
    name: "warlock:gate-a-resolve",
    // Must run before Vite's own core resolver: Vite silently externalizes
    // Node builtins into a `__vite-browser-external` stub for browser
    // builds, and would resolve `@warlock.js/*` packages via node_modules,
    // if either ran first. "The cheapest security mechanism wins" (RFC
    // §1.5) means this fence goes first, not last.
    enforce: "pre",
    async resolveId(source, importer, resolveOptions) {
      // Compute the path Gate A judges: for relative/absolute specifiers,
      // resolve against the importer's directory ourselves (filename-only
      // check, zero AST parsing, per `c604f0bc` §4) rather than delegating
      // to Vite's resolver first.
      const isRelativeOrAbsolute = source.startsWith(".") || path.isAbsolute(source);
      const judgedPath =
        isRelativeOrAbsolute && importer ? path.resolve(path.dirname(importer), source) : source;

      const violation = ruleViolation(source, judgedPath, importer, environmentOf, appRoot);
      if (violation) {
        const chain = [...buildChain(importer), source].join(" → ");
        this.error(
          [
            `Gate A refused an import: forbidden dependency reaches the client bundle.`,
            ``,
            `Import chain: ${chain}`,
            `File: ${importer ?? source}`,
            `Cause: ${violation.cause}`,
            `Fix: ${violation.fix}`,
          ].join("\n"),
        );
      }

      // Not forbidden — resolve for real so the chain map reflects Rollup's
      // actual resolved ids, then hand that resolution back so we don't do
      // the work twice.
      const resolved = await this.resolve(source, importer, { ...resolveOptions, skipSelf: true });
      if (resolved && importer) {
        importerOf.set(resolved.id, importer);
      }
      return resolved ?? null;
    },
  };
}
