/**
 * Gate A — `resolveId` refusal for the client build.
 *
 * Resolution fails for import PATHS that can never be client-safe:
 *   1. Node builtins (`fs`, `crypto`, `node:*`, ...) — see `isNodeBuiltin` for
 *      why the set is ASKED of Node rather than written down, and
 *      `externalizedBuiltins` for the one route that reaches a chunk
 *      without passing through `resolveId` at all. This rule is judged for
 *      EVERY importer, in or out of `GOVERNED_SCOPES` — see its note below.
 *   2. `@warlock.js/*` / `@mongez/*` packages whose `package.json` carries
 *      `"warlock": { "environment": "server" }`. An ABSENT marker is NOT a
 *      refusal — see the burden note on `createEnvironmentClassifier`. Judged
 *      only for imports whose importer is inside the app root — see
 *      `isInsideAppRoot` note below. An import statement carrying no VALUE
 *      binding is not refused but ERASED — see the type-only note on
 *      `recordImportKinds`.
 *   3. Server-only modules declared by FILE NAME: `*.server.ts` files,
 *      anything under a `.server/` directory, and — for the app's OWN source
 *      only — anything under a plain `server/` directory segment.
 *   4. Local modules outside a `$module/web/` (or `src/web/`) folder that are
 *      not a recognized universal surface (`*.page.tsx`, `layout.tsx`). The app
 *      root (`src/web/root.tsx`) is admitted by the `web/` FOLDER rule above,
 *      not by its name — see the note in `isRecognizedUniversalSurface`. A
 *      specifier that omits its file extension is judged on the file it will
 *      actually load, not on the extensionless string — see
 *      `completeLocalModulePath`.
 *   5. The `server-only` npm package — a module importing it has declared
 *      itself server-side and cannot reach the browser. Judged by NAME, right
 *      after rule 1 and ahead of rule 2's scope check; see
 *      `BOUNDARY_DECLARATION_PACKAGES`.
 *
 * Gate B (inline secrets), Gate C (output verification) and the SSR mirror
 * rule for a future client-only rendering primitive is NOT this gate. Do not
 * extend this file to cover them; they are separate, later slices.
 */
import { parse } from "@babel/parser";
import { builtinModules } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Node's OWN list of its builtins, read at runtime from `node:module`, never
 * copied into this file. A deny-list of names would be correct on the day it
 * was written and wrong on the day Node ships the next builtin — `node:sqlite`
 * and `node:test` are both recent enough to have missed any list this repo
 * could have hand-typed — and a fence that fails open on names nobody has
 * added yet is a fence with an expiry date nobody is watching. Asking the
 * runtime costs one import and cannot drift: the process doing the bundling is
 * the same process whose builtins are at issue.
 *
 * The `node:`-prefixed forms are handled separately (see `isNodeBuiltin`), so
 * this set only needs the names as `builtinModules` reports them.
 */
const NODE_BUILTINS = new Set(builtinModules);

/**
 * Every SPELLING of every builtin — bare and `node:`-prefixed — derived from
 * the set above rather than enumerated. Used only by
 * `externalizedBuiltins`, which has to interrogate a predicate it does
 * not control and therefore needs concrete strings to ask about. `node:test`,
 * `node:sea` and friends are reported by `builtinModules` ALREADY prefixed and
 * have no bare form at all, so they are passed through unchanged.
 */
const NODE_BUILTIN_SPELLINGS: string[] = [...NODE_BUILTINS].flatMap((name) =>
  name.startsWith("node:") ? [name] : [name, `node:${name}`],
);

export type WarlockEnvironment = "server" | "universal" | "client";

/**
 * Scopes whose `package.json` Gate A will read for a `warlock.environment`
 * marker. Third-party packages outside these two scopes (react, lodash, ...)
 * are never asked for this field — they are judged solely by Gate A's other,
 * import-based rules. Note that a governed package is only REFUSED when it
 * declares `"server"`; being in scope is not itself a refusal.
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
        if (
          pkg?.name === "warlock-workspace" &&
          Array.isArray(pkg.workspaces)
        ) {
          const packageJsonByName = new Map<string, string>();
          for (const workspace of pkg.workspaces as string[]) {
            const workspacePkgPath = path.join(dir, workspace, "package.json");
            if (!existsSync(workspacePkgPath)) continue;
            try {
              const workspacePkg = JSON.parse(
                readFileSync(workspacePkgPath, "utf-8"),
              );
              if (
                typeof workspacePkg.name === "string" &&
                isGovernedScope(`${workspacePkg.name}/`)
              ) {
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
function findNodeModulesPackageJson(
  pkgName: string,
  startDir: string,
): string | undefined {
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

/**
 * The governed-scope package name owning `normalized` (an already-`/`-
 * normalized absolute path), found by taking the LAST `node_modules/`
 * segment — nested `node_modules` (a dependency's own vendored copy) must
 * resolve to the nearest enclosing package, not the outermost one. Returns
 * `undefined` for paths with no `node_modules` segment, or whose owning
 * package isn't in a governed scope.
 */
function packageNameFromNodeModulesPath(
  normalized: string,
): string | undefined {
  const segments = normalized.split("node_modules/");
  if (segments.length < 2) return undefined;
  const afterLast = segments[segments.length - 1];
  const parts = afterLast.split("/");
  const name = afterLast.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  return isGovernedScope(`${name}/`) ? name : undefined;
}

/**
 * The two npm packages whose entire published API is a declaration of which
 * side of the client/server boundary their importer belongs to: importing
 * `server-only` says "this module must never reach the browser", importing
 * `client-only` says the mirror. Mapped to the environment each one declares
 * of its IMPORTER.
 *
 * Recognized by NAME, ahead of rule 2's scope check, for a reason that is not
 * a special case: both sit outside `GOVERNED_SCOPES`, so `environmentOf` is
 * never consulted for them under ANY default — no marker resolution, current
 * or future, can ever classify them. Their name IS the marker, and reading it
 * is the same move rule 3 makes when it reads `.server.ts` off a file name.
 *
 * Only a `"server"` declaration is a violation HERE. `client-only` is
 * recognized and deliberately permitted: this is the client build, so a module
 * declaring itself client-side is exactly where it belongs. Judging it is the
 * SSR mirror rule's job, and that gate is not this file (see the header note).
 */
const BOUNDARY_DECLARATION_PACKAGES: Record<string, WarlockEnvironment> = {
  "server-only": "server",
  "client-only": "client",
};

/**
 * The boundary-declaration package a specifier reaches, if any — matching the
 * package itself or a subpath of it (`server-only/empty` is a real published
 * entry point), never a merely similar name like `server-only-utils`.
 */
function boundaryDeclarationOf(
  source: string,
): { name: string; declares: WarlockEnvironment } | undefined {
  for (const [name, declares] of Object.entries(
    BOUNDARY_DECLARATION_PACKAGES,
  )) {
    if (source === name || source.startsWith(`${name}/`))
      return { name, declares };
  }
  return undefined;
}

/**
 * Whether a specifier names a Node builtin, in either spelling.
 *
 * The `node:` prefix is answered by SHAPE, not by membership: the prefix is
 * reserved by Node for builtins and nothing else can ever legally claim it, so
 * `node:anything` is refused even when `builtinModules` has never heard of it.
 * That covers the prefix-only builtins (`node:test`, `node:sqlite`, `node:sea`)
 * on Node versions whose `builtinModules` omits them, and every builtin Node
 * has not shipped yet, without this file knowing a single one of their names.
 *
 * Bare names fall through to Node's own set, which already carries the subpath
 * entries (`fs/promises`, `stream/web`, `timers/promises`, ...) as first-class
 * members — they need no prefix matching of their own.
 */
function isNodeBuiltin(source: string): boolean {
  if (source.startsWith("node:")) return true;
  return NODE_BUILTINS.has(source);
}

function normalize(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

/**
 * A plain `server/` path segment, tested against a path ALREADY made relative
 * to the app root — never against the absolute path. An app checked out at
 * `D:/work/server/shop` would otherwise have every one of its own files match.
 */
const APP_SERVER_SEGMENT = /(^|\/)server(\/|$)/;

export function isServerFile(resolvedPath: string, appRoot: string): boolean {
  // A Vite query suffix (`?raw`, `?worker`, `?url`, ...) changes how the
  // resolved id is CONSUMED, never which file on disk it names — the two
  // anchored patterns below test the END of the string, so a suffix still
  // attached at judgement time slides `.server`/`.server.ts` out from under
  // the `$` anchor and the file reads as clean. Stripped here, once, rather
  // than trusted to every caller: `bare` is what every check below judges,
  // matching `completeLocalModulePath`'s own bare/query split for the same
  // specifier (see its note).
  const bare = resolvedPath.split("?")[0];
  const normalized = normalize(bare);
  // `.server` may or may not carry an extension by the time Gate A judges it
  // — a bare specifier like `./blog.server` (extension resolved later by
  // Vite) must be caught just as `./blog.server.ts` is.
  if (/\.server(\.[jt]sx?)?$/.test(normalized)) return true;
  if (/(^|\/)\.server(\/|$)/.test(normalized)) return true;
  // A plain `server/` directory is judged for APP SOURCE ONLY, unlike the two
  // patterns above. `.server` in a filename is an unambiguous declaration
  // wherever it appears; a directory literally called `server/` is ordinary
  // internal layout for a dependency — `@warlock.js/web` keeps its own
  // sources in `web/src/server/` — so judging it everywhere would refuse the
  // framework itself. `isAppSourcePath` is the same app-source/dependency
  // distinction rule 4 draws, not a second one.
  if (isAppSourcePath(bare, appRoot)) {
    if (APP_SERVER_SEGMENT.test(normalize(path.relative(appRoot, bare))))
      return true;
  }
  return false;
}

export function isRecognizedUniversalSurface(resolvedPath: string): boolean {
  const normalized = normalize(resolvedPath);
  const base = path.basename(normalized);
  if (/\.page\.tsx?$/.test(base)) return true;
  if (base === "layout.tsx" || base === "layout.ts") return true;
  // There is deliberately NO app-root (`src/web/root.tsx`) case here, and
  // adding one would be dead code. The app root lives directly inside a
  // `web/` folder, so `isWithinModuleWebFolder` — which the only caller,
  // `isOutsideUniversalScope`, tests on the line BEFORE this function is
  // reached — already admits it by folder, whatever the file is named. A name
  // test here could never fire; the root's name is not what makes it
  // universal. (Verified: removing such a test leaves the app-root and
  // ordinary-sibling cases in `gate-a-resolve.spec.ts` passing.)
  return false;
}

/**
 * A `web/` path segment, tested — like `APP_SERVER_SEGMENT` above and for the
 * same reason — against a path ALREADY made relative to the app root.
 *
 * Never against the absolute path, and this repo is its own proof: Gate A's
 * fixtures live at `@warlock.js/web/__tests__/vite/fixtures/gate-a/...`, so
 * EVERY absolute path under them contains a `/web/` segment belonging to the
 * package directory rather than to any app module. Matched absolutely, rule 4
 * would admit the whole fixture tree and cases 9 and 25-28 would all go green
 * for the wrong reason.
 */
const MODULE_WEB_SEGMENT = /(^|\/)web(\/|$)/;

/**
 * Whether a judged path is anywhere INSIDE a module's `web/` folder — at any
 * depth, not merely directly inside one.
 *
 * The depth matters and used to be wrong: this asked for `/web/<one-segment>`,
 * so `src/web/middleware/base.middleware.ts` — two segments in — did not count
 * as being within `src/web/` at all. Nothing had noticed because the only way
 * to reach such a file is a relative import, and rule 4 was not judging those
 * (see `completeLocalModulePath`): a nested universal file escaped the rule
 * rather than being admitted by it, and the two are indistinguishable until the
 * escape is closed. Closing it without this would have turned the v5 app's own
 * `src/web/root.tsx` — which imports exactly that middleware — into a refusal.
 *
 * Rule 4's premise is a FOLDER ("outside a `$module/web/` folder"), and a
 * subfolder of `web/` is inside it. `web/components/`, `web/layouts/` and
 * `web/utils/` are ordinary app layout, not a way around the fence.
 */
export function isWithinModuleWebFolder(
  resolvedPath: string,
  appRoot: string,
): boolean {
  return MODULE_WEB_SEGMENT.test(
    normalize(path.relative(appRoot, resolvedPath)),
  );
}

/**
 * Rule 4's subject set: local files that CARRY CODE. Deliberately the same
 * shape as `PARSEABLE_MODULE_EXTENSIONS` below — one notion of "this is a
 * JS/TS module" for the whole file — which also picks up `.mts`/`.cts`, absent
 * from the earlier hand-spelled `/\.(tsx?|jsx?|mjs|cjs)$/`. `.mts` is a real
 * module extension Vite resolves, so a file wearing it was walking past rule 4
 * with its extension written out in full.
 *
 * Every extension `IMPLICIT_MODULE_EXTENSIONS` can append MUST match this —
 * see the note there.
 */
const LOCAL_MODULE_EXTENSIONS = /\.([cm]?[jt]sx?)$/;

/**
 * The extensions a local specifier may leave off, in Vite's own
 * `resolve.extensions` order.
 *
 * `.json` is deliberately absent: it is not code-carrying, so completing to it
 * would only hand rule 4 a path it exempts one line later, and the exemption is
 * the correct answer for a data file.
 *
 * The list and `LOCAL_MODULE_EXTENSIONS` have to agree in one direction: an
 * extension this list can PRODUCE but that regex does not RECOGNIZE is a fresh
 * escape hatch of exactly the shape this completion exists to close — the
 * judged path would gain a suffix and still be waved through. Pinned by case 32
 * in the spec. The order only decides which of two same-named files gets
 * judged, and every rule downstream (`isServerFile`, `isWithinModuleWebFolder`,
 * `isRecognizedUniversalSurface`) answers identically for `x.ts` and `x.js`, so
 * matching Vite is for least surprise rather than for correctness.
 */
const IMPLICIT_MODULE_EXTENSIONS = [
  ".mjs",
  ".js",
  ".mts",
  ".ts",
  ".jsx",
  ".tsx",
  ".cjs",
  ".cts",
];

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * The file a local specifier will ACTUALLY load, given the path `resolveId`
 * derived from it with a raw `path.resolve`.
 *
 * Without this, rule 4 was escapable by writing the import the ordinary way.
 * `resolveId` runs before anything appends an extension, so `./services/helper`
 * arrives as a path ending in `helper`; rule 4 asks for a code extension —
 * rightly, since it has no business judging `./logo.css` — finds none, and
 * declines to judge at all. `./x.middleware` slipped the same way while LOOKING
 * like it had an extension, and so did `./services` resolving to
 * `services/index.ts`. Measured: all three built clean (spec cases 25-28, 32).
 *
 * Asked of the FILESYSTEM rather than answered from the string, because the
 * string cannot tell an omitted extension from a real one: `.middleware` is not
 * a code extension and not an asset extension either, and only the disk knows
 * whether `thing.middleware.ts` is sitting there. Probing `<path><ext>` and
 * then `<path>/index<ext>` is what Vite is about to do anyway, so the rule
 * judges the file that will really be bundled.
 *
 * Deliberately NOT cached. A handful of `stat` calls per local specifier is
 * what every resolver in the pipeline already spends, and a cache would go
 * stale in watch mode exactly when a file is created or deleted — which is the
 * moment a fence must not be answering from memory.
 *
 * Two early exits, each a case where completion has nothing to add or no
 * business guessing:
 *   - a non-absolute path (a bare package specifier — rules 1/2's business)
 *     or a virtual `\0` id;
 *   - a path that already carries a code extension, or that already exists as a
 *     real non-code file (an asset — `./theme.css`), where the path on hand is
 *     the answer.
 *
 * A Vite query suffix (`./helper?raw`, `./thing?worker`, `./thing?url`) is
 * split off BEFORE any of that: the query changes what the id MEANS to Vite,
 * never which file on disk answers to it, so completion and every downstream
 * policy check (`isServerFile`) judge the BARE path — `./blog.server?raw`
 * must be caught exactly as `./blog.server` is, and used to slip through
 * here because the whole path, query included, was handed back unexamined.
 * The suffix is reattached to whatever this returns, because that IS the id
 * Vite will actually load (`resolve.extensions` completion happens first,
 * the query is consumed after) — nothing downstream should have to re-derive
 * it from the original specifier.
 */
function completeLocalModulePath(judgedPath: string): string {
  if (!path.isAbsolute(judgedPath)) return judgedPath;
  if (judgedPath.includes("\0")) return judgedPath;

  const queryIndex = judgedPath.indexOf("?");
  const barePath =
    queryIndex === -1 ? judgedPath : judgedPath.slice(0, queryIndex);
  const querySuffix = queryIndex === -1 ? "" : judgedPath.slice(queryIndex);

  return `${completeBareLocalModulePath(barePath)}${querySuffix}`;
}

function completeBareLocalModulePath(judgedPath: string): string {
  if (LOCAL_MODULE_EXTENSIONS.test(judgedPath)) return judgedPath;
  if (path.extname(judgedPath) !== "" && isFile(judgedPath)) return judgedPath;

  for (const extension of IMPLICIT_MODULE_EXTENSIONS) {
    const candidate = `${judgedPath}${extension}`;
    if (isFile(candidate)) return candidate;
  }
  // A directory only after every file candidate has failed — that is Node's and
  // Vite's order too, so `x.ts` beside `x/index.ts` is judged as `x.ts`.
  for (const extension of IMPLICIT_MODULE_EXTENSIONS) {
    const candidate = path.join(judgedPath, `index${extension}`);
    if (isFile(candidate)) return candidate;
  }

  // Nothing on disk answers to it. Left exactly as it arrived: resolution is
  // about to fail on its own, and a fence should not be inventing a verdict
  // about a file that is not there.
  return judgedPath;
}

/**
 * Rule 4 only judges local, code-carrying files INSIDE the app's own project
 * root — package specifiers are already covered by rules 1/2, non-code assets
 * (css, images, ...) are not the "server/client leak" shape this rule exists to
 * catch, and a dependency's own internal file layout (e.g. `@warlock.js/seal`'s
 * `src/rules/**`) is not organized by the `$module/web/` convention at all,
 * so judging it by that convention would fence out every third-party import.
 *
 * NOTHING HERE READS THE SPECIFIER, and that is the fix for the escape this
 * rule shipped with. It used to open with
 * `source.startsWith(".") || path.isAbsolute(source)` and return `false` for
 * anything else — so an import written in ALIAS form (`app/users/...`,
 * `web/...`, the shape `v5/app/tsconfig.json`'s `paths` and
 * `web-connector.ts`'s `resolve.alias` give every v5 app) was never judged at
 * all, whatever file it reached. Rule 4's subject is a FILE; the string the
 * author happened to type to name that file is not evidence about it. See the
 * spelling-equivalence suite in the spec — one target file, four spellings, one
 * judgement.
 *
 * Dropping that test narrows nothing and widens nothing for the specifiers it
 * used to admit, because `isAppSourcePath` below already requires an ABSOLUTE
 * path: a bare specifier's "judged path" is still the specifier string itself
 * (see `resolveId`), which is never absolute, so it falls out one line later
 * exactly as before. What changed is that a CALLER may now hand this rule a
 * resolved absolute path for a specifier that was not written relatively —
 * which is what `resolveId`'s alias pass does.
 *
 * `resolvedPath` must have been through `completeLocalModulePath` before it
 * gets here, or the extension test below is a way OUT of this rule rather than
 * a narrowing of it — see that function.
 */
function isOutsideUniversalScope(
  resolvedPath: string,
  appRoot: string,
): boolean {
  if (!LOCAL_MODULE_EXTENSIONS.test(resolvedPath)) return false;
  if (!isAppSourcePath(resolvedPath, appRoot)) return false;
  // Order matters: `isAppSourcePath` above is what makes the app-root-relative
  // test in `isWithinModuleWebFolder` meaningful — it has already established
  // the path is absolute and inside `appRoot`.
  if (isWithinModuleWebFolder(resolvedPath, appRoot)) return false;
  if (isRecognizedUniversalSurface(resolvedPath)) return false;
  return true;
}

/**
 * Whether a judged path is the APP'S OWN SOURCE, as opposed to a dependency's
 * internals. This is Gate A's single definition of that boundary — rules 3
 * and 4 both call it, and `packageNameForFilePath` draws the same line for
 * Gate C. Two conditions, both already required by rule 4 before this was
 * extracted:
 *
 *   - inside `appRoot` (a monorepo sibling or any other path resolution has
 *     left the app root for is that package's own business), and
 *   - not under a `node_modules/` segment. Nested `node_modules` inside
 *     `appRoot` is the ORDINARY case for a dependency, and Vite's optimized
 *     dependency chunks (`<appRoot>/node_modules/.vite/deps`) even import one
 *     another relatively.
 *
 * Bare package specifiers never reach here as app source: for those the
 * "judged path" is still the specifier string itself (see `resolveId`), which
 * is not absolute. They are rule 2's business.
 */
export function isAppSourcePath(
  resolvedPath: string,
  appRoot: string,
): boolean {
  if (!path.isAbsolute(resolvedPath)) return false;
  if (!isInsideAppRoot(resolvedPath, appRoot)) return false;
  return !normalize(resolvedPath).includes("/node_modules/");
}

function isInsideAppRoot(resolvedPath: string, appRoot: string): boolean {
  const relative = path.relative(appRoot, resolvedPath);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/* ------------------------------------------------------------------------ *
 * Type-only import edges (rule 2 only)
 * ------------------------------------------------------------------------ */

/**
 * How an importer's source text binds a specifier: `"value"` if ANY statement
 * mentioning that specifier can produce a runtime binding or a runtime edge,
 * `"type"` only when every one of them is erased by the type system.
 */
type ImportKind = "value" | "type";

/** Files whose source Gate A will parse for import kinds. */
const PARSEABLE_MODULE_EXTENSIONS = /\.([cm]?[jt]sx?)$/;

/** Cheap pre-filter: no governed scope in the text, nothing to classify. */
const GOVERNED_SCOPE_MENTION = /@warlock\.js\/|@mongez\//;

/**
 * The id Gate A resolves a type-only edge into a server-only package to. `\0`
 * is the virtual-module convention, which also keeps Gate C from trying to
 * attribute this id to a package on disk (`packageNameForFilePath` returns
 * `undefined` for any id containing `\0` — see its note).
 */
const TYPE_ONLY_ERASED_ID = "\0warlock:type-only-erased";

/**
 * Rollup module ids carry query suffixes (`?v=`, `?used`, ...) that differ
 * between the `transform` id and a later `importer`. Both sides key through
 * here so they agree.
 */
function moduleKey(id: string): string {
  return normalize(id.split("?")[0]);
}

function parserPluginsFor(id: string): ("typescript" | "jsx")[] {
  // `jsx` on a `.ts` file mis-parses the type-assertion form `<T>value`, which
  // is legal there and only there. Everything else (including plain `.js`) is
  // parsed with both, since JSX in a `.js` file is ordinary in this ecosystem.
  return /\.[cm]?ts$/.test(moduleKey(id))
    ? ["typescript"]
    : ["typescript", "jsx"];
}

/**
 * Whether an `ImportDeclaration`'s specifier list is entirely type-only.
 *
 * Both spellings count, because both are erased: the statement form
 * (`import type { X } from "P"`, `decl.importKind === "type"`) and the inline
 * form (`import { type X } from "P"`, every specifier's own `importKind`).
 * The inline form is the one that matters in practice — under
 * `verbatimModuleSyntax` TypeScript/esbuild emit it VERBATIM as
 * `import {} from "P"`, so it is the only one that survives to `resolveId` at
 * all.
 *
 * An EMPTY specifier list (`import "P"`) is deliberately `"value"`: a bare
 * side-effect import is a real runtime edge that the author wrote on purpose,
 * and it is indistinguishable — post-esbuild — from the erased form. Treating
 * it as type-only would turn this carve-out into a hole big enough to smuggle
 * a whole server package through.
 */
function importDeclarationKind(decl: any): ImportKind {
  if (decl.importKind === "type") return "type";
  if (decl.specifiers.length === 0) return "value";
  return decl.specifiers.every((spec: any) => spec.importKind === "type")
    ? "type"
    : "value";
}

function exportDeclarationKind(stmt: any): ImportKind {
  if (stmt.exportKind === "type") return "type";
  const specifiers = stmt.specifiers ?? [];
  if (specifiers.length === 0) return "value"; // `export * from "P"` — a runtime edge.
  return specifiers.every((spec: any) => spec.exportKind === "type")
    ? "type"
    : "value";
}

/**
 * Every specifier reached by a RUNTIME expression rather than a static
 * import/export statement — `import("P")` and `require("P")` — found by a
 * duck-typed walk of the whole program, not just its top level, because both
 * are ordinary expressions and can sit anywhere.
 *
 * These are unconditionally `"value"`. A dynamic import of a server-only
 * package is exactly the edge rule 2 exists to refuse, and it reaches
 * `resolveId` with the same specifier string a static import would, so
 * without this walk a file could hold `import { type X } from "P"` beside
 * `await import("P")` and have the static statement's kind exempt the dynamic
 * one.
 */
function collectRuntimeSpecifiers(node: unknown, into: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectRuntimeSpecifiers(item, into);
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.type !== "string") return;
  if (record.type === "CallExpression" || record.type === "ImportExpression") {
    const callee = (record as any).callee;
    const isRuntimeLoad =
      record.type === "ImportExpression" ||
      callee?.type === "Import" ||
      (callee?.type === "Identifier" && callee.name === "require");
    if (isRuntimeLoad) {
      const arg = (record as any).source ?? (record as any).arguments?.[0];
      if (arg?.type === "StringLiteral" && typeof arg.value === "string")
        into.add(arg.value);
    }
  }
  for (const key of Object.keys(record)) {
    if (
      key === "type" ||
      key === "start" ||
      key === "end" ||
      key === "loc" ||
      key === "range"
    )
      continue;
    if (
      key === "leadingComments" ||
      key === "trailingComments" ||
      key === "innerComments" ||
      key === "extra"
    ) {
      continue;
    }
    collectRuntimeSpecifiers(record[key], into);
  }
}

/**
 * Classifies every specifier `code` imports as `"value"` or `"type"`. Returns
 * `undefined` when the source could not be parsed — the caller reads that as
 * "no information", which leaves rule 2 refusing exactly as it does today.
 */
function classifyImportKinds(
  code: string,
  id: string,
): Map<string, ImportKind> | undefined {
  let ast;
  try {
    ast = parse(code, {
      sourceType: "module",
      plugins: parserPluginsFor(id),
      errorRecovery: false,
    });
  } catch {
    return undefined;
  }

  const kinds = new Map<string, ImportKind>();
  // `"value"` always wins a merge: one value edge anywhere in the file is
  // enough to make the specifier a runtime dependency, however many type-only
  // statements sit beside it.
  const record = (source: string, kind: ImportKind) => {
    if (kind === "value" || !kinds.has(source)) kinds.set(source, kind);
  };

  for (const stmt of ast.program.body as any[]) {
    if (stmt.type === "ImportDeclaration") {
      record(stmt.source.value as string, importDeclarationKind(stmt));
      continue;
    }
    if (
      (stmt.type === "ExportNamedDeclaration" ||
        stmt.type === "ExportAllDeclaration") &&
      stmt.source
    ) {
      record(stmt.source.value as string, exportDeclarationKind(stmt));
    }
  }

  const runtimeSpecifiers = new Set<string>();
  collectRuntimeSpecifiers(ast.program.body, runtimeSpecifiers);
  for (const source of runtimeSpecifiers) kinds.set(source, "value");

  return kinds;
}

interface FenceViolation {
  cause: string;
  fix: string;
}

/**
 * Rule 2's predicate on its own, extracted so `resolveId` can ask the question
 * a SECOND time after `ruleViolation` has declined to refuse: a type-only edge
 * into a server-only package is not a violation, but it is not an ordinary
 * import either — it is erased (see `TYPE_ONLY_ERASED_ID`). Asking separately,
 * rather than short-circuiting inside `ruleViolation`, is what keeps rules 3
 * and 4 authoritative over a type-only specifier: `@warlock.js/core/db.server`
 * imported for its types alone is still refused, by rule 3, because
 * `ruleViolation` still runs to completion first.
 */
function isServerMarkedGovernedPackage(
  source: string,
  importer: string | undefined,
  environmentOf: (pkgName: string) => WarlockEnvironment,
  appRoot: string,
): boolean {
  if (!isGovernedScope(source)) return false;
  if (importer && !isInsideAppRoot(importer, appRoot)) return false;
  return environmentOf(governedPackageNameOf(source)) === "server";
}

function ruleViolation(
  source: string,
  resolvedPath: string,
  importer: string | undefined,
  environmentOf: (pkgName: string) => WarlockEnvironment,
  appRoot: string,
  isTypeOnlyEdge: boolean,
): FenceViolation | undefined {
  // Rule 1 takes NO importer into account, and that is deliberate rather than
  // an omission. Rule 2's `GOVERNED_SCOPES` / `isInsideAppRoot` narrowing is
  // right for the environment MARKER, which is a claim we only make about
  // packages we publish; we do not get to judge whether Radix or Mantine is
  // server-side. A Node builtin is not that kind of judgement. `node:fs` has no
  // browser implementation whoever wrote the import — the app's own source, a
  // governed package, or a transitive dependency six hops down — so this rule
  // is judged for every importer and, unlike rule 2, is never exempted by a
  // type-only edge (see the `isTypeOnlyEdge` note below).
  if (isNodeBuiltin(source)) {
    return {
      cause: `"${source}" is a Node.js builtin module and cannot run in the browser.`,
      fix: `Move the code that needs "${source}" into a *.server.ts file or a server-only loader/controller, and pass only serializable data to the client.`,
    };
  }

  const boundaryDeclaration = boundaryDeclarationOf(source);
  if (boundaryDeclaration?.declares === "server") {
    const declarer = importer ? displayName(importer) : source;
    return {
      cause: `"${declarer}" imports "${boundaryDeclaration.name}" — that package publishes no API at all, only a declaration: any module importing it is server-side and must never be bundled for the browser.`,
      fix: `Move the server work in "${declarer}" into a *.server.ts file, a server/ folder, a loader, or a controller — the client only needs the serialized data it returns — or, if this module is genuinely browser-safe, remove its "${boundaryDeclaration.name}" import.`,
    };
  }

  // Rule 2 is judged only for imports whose importer is app-authored code
  // (inside `appRoot`) — mirroring rule 4's existing dependency-internals
  // exemption below. A governed package's OWN internal composition (e.g.
  // `@warlock.js/seal` importing `@mongez/reinforcements`) is that package's
  // business, not the app's; what Gate A polices is the app reaching INTO a
  // server-only package, not what a package it's already allowed to use does
  // internally.
  // `isTypeOnlyEdge` exempts rule 2 and NOTHING else. A refusal here is a
  // statement about what the app will EXECUTE, and an import statement with no
  // value binding executes nothing from the package — refusing it would be a
  // false positive on code that is already correct, which is how people learn
  // to switch a fence off. Rules 1, 3, 4 and 5 are untouched by this flag on
  // purpose: they judge the importer's own nature or a file name, neither of
  // which a type-only spelling changes.
  if (
    !isTypeOnlyEdge &&
    isServerMarkedGovernedPackage(source, importer, environmentOf, appRoot)
  ) {
    const pkgName = governedPackageNameOf(source);
    const scopeLabel = pkgName.startsWith("@warlock.js/")
      ? "@warlock.js"
      : "@mongez";
    return {
      cause: `"${source}" resolves into ${pkgName}, a server-only ${scopeLabel} package — it declares "warlock": { "environment": "server" } in its package.json.`,
      fix: `Move this import behind a *.server.ts file, a server/ folder, a loader, or a controller — the client only needs the serialized data it returns — or, if ${pkgName} is genuinely universal/client-safe, change its marker to "warlock": { "environment": "universal" } (or "client").`,
    };
  }

  if (isServerFile(resolvedPath, appRoot)) {
    return {
      cause: `"${source}" is a server-only file — its name declares it: it matches *.server.ts, or it lives under a .server/ directory, or under a server/ folder in this app's source.`,
      fix: `Import the data this file produces through a loader instead of importing the server file directly, or move the shared logic into a universal helper under $module/web/ — outside any server/ folder and without a .server suffix.`,
    };
  }

  // RULE 4 IS GONE, DELIBERATELY. Owner ruling 2026-08-24 (canon `10f6041c`):
  // the client boundary is decided by the import GRAPH, not by file location.
  //
  // It used to refuse any app file living outside `$module/web/`. That is a
  // PROXY for danger, and it produced exactly the false positives you would
  // expect from a proxy:
  //
  //   - `app/auth/schema/login.schema.ts` imports only `@warlock.js/seal`
  //     (marked universal) and was refused for its address.
  //   - `app/access/permissions.ts` imports NOTHING — two frozen objects of
  //     name constants — and was refused for its address.
  //
  // Both are genuinely universal: the server validates and authorises with
  // them, the client renders and validates with them. Every location-based fix
  // for that (move them, rename them, add a folder) was rejected by the owner
  // because it forces app structure to serve the fence rather than the app.
  //
  // WHAT STILL REFUSES, and why this is not a weakening:
  //   rule 1  — a Node builtin anywhere in the graph, at any depth, any importer
  //   rule 1b — a `server-only` boundary declaration
  //   rule 2  — a governed package MARKED `environment: "server"`
  //   rule 3  — a file that names itself server (`*.server.ts`, `server/`)
  //
  // Server-ness now PROPAGATES: a file is refused when something it reaches is
  // server-only, and the chain is printed so the refusal names the real cause
  // instead of an address. `nav.service` is still refused — not for sitting
  // outside `web/`, but for reaching auth and the user model.
  //
  // THE KNOWN GAP, recorded rather than hidden: a file that is secret but
  // imports nothing suspicious (a hardcoded key) is invisible to the graph.
  // `*.server.ts` above is the manual escape hatch for exactly that case.
  return undefined;
}

/**
 * The label one hop of an import chain carries.
 *
 * A basename is enough for the app's own source, where file names are chosen
 * and distinct. It is not enough for a dependency: a large share of
 * node_modules resolves to a file literally called `index.js`, and a chain
 * reading `page.tsx → index.js → node:fs` names the culprit for nobody — which
 * is the failure mode where people switch the fence off instead of fixing the
 * import. Anything under a `node_modules/` segment is therefore labelled with
 * its path from the LAST such segment (`vendor-node-lib/index.js`), so a
 * vendored nested copy reports the package that actually holds the file rather
 * than the one at the top of the tree.
 */
function displayName(id: string): string {
  const normalized = normalize(id);
  const segments = normalized.split("node_modules/");
  if (segments.length < 2) return path.basename(normalized);
  return segments[segments.length - 1];
}

/** Rollup's normalized `external`, as `buildStart` receives it. */
type ExternalPredicate = (
  id: string,
  importer: string | undefined,
  isResolved: boolean,
) => unknown;

/**
 * Every Node builtin the Rollup config would externalize — empty when none,
 * which is the only shape that lets a build proceed past `buildStart`.
 *
 * This is the one route a builtin can take into a browser chunk without ever
 * being offered to `resolveId`: Rollup consults `external` FIRST, and an
 * externalized specifier is emitted into the output verbatim — measured, on
 * this gate's own fixture, as a clean build whose chunk still opens with
 * `import { readFileSync } from "node:fs"`. No `resolveId` rule can close that,
 * because the hook is never called; the check has to happen against the config
 * itself, before any module is loaded.
 *
 * Asked as a QUESTION of the normalized predicate rather than by reading an
 * array, because `external` may legitimately be a string, a RegExp, an array of
 * either, or a function — Rollup normalizes all of them into the function
 * handed to `buildStart`, and asking it about each builtin spelling is the only
 * form of the check that covers every shape. A predicate that throws on an
 * unexpected shape of argument is read as "not external": this guard exists to
 * catch a config that says yes, and inventing a refusal out of someone else's
 * exception would be a false positive with no evidence behind it.
 *
 * This fires on CONFIGURATION, not on an actual import — nothing need import
 * `fs` for it to trip. That is on purpose: the config has already decided the
 * fence does not apply, and a build that would silently pass today only because
 * no import happens to exist yet is not a build anyone should trust tomorrow.
 */
function externalizedBuiltins(isExternal: unknown): string[] {
  if (typeof isExternal !== "function") return [];
  const asks = isExternal as ExternalPredicate;
  return NODE_BUILTIN_SPELLINGS.filter((specifier) => {
    try {
      return asks(specifier, undefined, false) === true;
    } catch {
      return false;
    }
  });
}

export interface EnvironmentClassifierOptions {
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
   * The app's project root. Defines what counts as APP SOURCE (see
   * `isAppSourcePath`), which two rules depend on: rule 4 ("outside
   * `$module/web/`") and rule 3's plain-`server/`-folder half. A dependency's
   * own internal file layout — reached once resolution has left the app root,
   * or through a `node_modules/` segment — is exempt from both, though rules
   * 1, 2 and the `.server` half of rule 3 still apply to it. Defaults to
   * `process.cwd()`, matching Vite's own default `root`.
   */
  appRoot?: string;
}

type GateAOptions = EnvironmentClassifierOptions;

export interface EnvironmentClassifier {
  appRoot: string;
  environmentOf(pkgName: string): WarlockEnvironment;
  /**
   * Maps an absolute, already-resolved file path (e.g. a Rollup
   * `OutputChunk.moduleIds` entry) back to the governed-scope package name
   * that owns it — a `node_modules` dependency, or a workspace member's own
   * directory PROVIDED the path is outside `appRoot`. The `appRoot` carve-out
   * matters: a fixture/app can physically live inside a workspace package's
   * own directory tree (e.g. this repo's own `web/__tests__/` fixtures live
   * under the `web` package) without thereby "importing" that package — the
   * app's own source is never a dependency edge onto itself, no matter where
   * on disk it happens to sit (same distinction Gate A's rule 2 already makes
   * via `isInsideAppRoot` for the importer side). `undefined` when the path
   * isn't a governed-scope dependency at all. Exists so Gate C
   * (`gate-c-verify.ts`) can classify modules already sitting in the EMITTED
   * bundle graph using this exact same marker logic, instead of hand-rolling
   * a second classification scheme — Gate C re-derives, it does not
   * duplicate.
   */
  packageNameForFilePath(absPath: string): string | undefined;
}

/**
 * The `warlock.environment` marker classifier (rule 2). Extracted from
 * `gateAResolve` so Gate C can classify packages it finds in the EMITTED
 * bundle graph with the identical resolution logic — same workspace index,
 * same `node_modules` fallback, same default — rather than a second,
 * potentially-drifting implementation.
 *
 * An ABSENT marker classifies as `"universal"`, i.e. allowed. This is a
 * deliberate reversal of the earlier burden-inversion default. A marker is
 * shipped metadata: making silence mean "refuse" meant every browser-safe
 * package we own needed a marker AND a release before any app could boot, and
 * a package the app does not control (`@mongez/react-atom`) could not be
 * imported at all. Refusal is now driven by information that is PRESENT — an
 * explicit `"server"` marker, or a server-only file name (rule 3) — which the
 * app author can always supply themselves without waiting on a release. The
 * marker mechanism itself is untouched and still authoritative when set.
 */
export function createEnvironmentClassifier(
  options: EnvironmentClassifierOptions = {},
): EnvironmentClassifier {
  const forcedServerPackages = options.serverPackages
    ? new Set(options.serverPackages)
    : undefined;
  const appRoot = path.resolve(options.appRoot ?? process.cwd());
  const workspaceIndex = findWorkspaceIndex(__dirname);
  const environmentCache = new Map<string, WarlockEnvironment>();

  function environmentOf(pkgName: string): WarlockEnvironment {
    if (forcedServerPackages?.has(pkgName)) return "server";
    const cached = environmentCache.get(pkgName);
    if (cached) return cached;

    const packageJsonPath =
      workspaceIndex?.packageJsonByName.get(pkgName) ??
      findNodeModulesPackageJson(pkgName, appRoot);

    let environment: WarlockEnvironment = "universal";
    if (packageJsonPath) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
        const marker = pkg?.warlock?.environment;
        if (
          marker === "server" ||
          marker === "universal" ||
          marker === "client"
        ) {
          environment = marker;
        }
      } catch {
        // Unreadable package.json — no marker could be read, so the permissive
        // default applies, exactly as for a package that carries none.
      }
    }

    environmentCache.set(pkgName, environment);
    return environment;
  }

  function packageNameForFilePath(absPath: string): string | undefined {
    // A Rollup module id is not always a file path. `\0` is the universal
    // virtual-module convention (Vite's own `createFilter` refuses any id
    // containing it), and a virtual module has no package on disk to attribute
    // it to. Without this guard `path.resolve` grafts the synthetic id onto
    // `process.cwd()` and the workspace-root prefix scan below then attributes
    // it to whichever package the BUILD PROCESS happens to be running inside —
    // so `\0virtual:warlock/pages` gets classified as "@warlock.js/web,
    // server-only" and Gate C refuses a build over a module that never touched
    // the filesystem. That failure is loud rather than silent, but it is still
    // wrong, and it makes every virtual module unbuildable whenever cwd sits
    // inside a governed-scope package. Nothing is weakened by returning
    // `undefined` here: a virtual module's own IMPORTS resolve to real paths
    // that this function still classifies, and its emitted code is still
    // subject to Gate C's server-export scan and Gate B's transform.
    if (absPath.includes("\0")) return undefined;

    const normalized = normalize(path.resolve(absPath));

    // node_modules is unambiguous — always a dependency, even when nested
    // inside appRoot (the ordinary case: `appRoot/node_modules/...`).
    const nodeModulesMatch = packageNameFromNodeModulesPath(normalized);
    if (nodeModulesMatch) return nodeModulesMatch;

    // Everything else inside appRoot is the app's OWN source, never a
    // dependency edge, regardless of which workspace package's directory it
    // happens to physically sit under — see the appRoot carve-out note above.
    if (isInsideAppRoot(normalized, appRoot)) return undefined;

    if (workspaceIndex) {
      for (const [name, pkgJsonPath] of workspaceIndex.packageJsonByName) {
        const root = `${normalize(path.dirname(pkgJsonPath))}/`;
        if (normalized.startsWith(root)) return name;
      }
    }
    return undefined;
  }

  return { appRoot, environmentOf, packageNameForFilePath };
}

/**
 * The client-build Vite plugin. `vite` is only imported for its types
 * (`import type`), so this module carries no runtime dependency on `vite`
 * being installed — it is a `peerDependenciesMeta.optional` peer.
 */
export function gateAResolve(options: GateAOptions = {}): Plugin {
  const { appRoot, environmentOf } = createEnvironmentClassifier(options);

  // Maps a resolved module id to the id that imported it, rebuilt per plugin
  // instance (i.e. per build) via our own `this.resolve` calls below — this
  // does not depend on Rollup's internal module-graph bookkeeping being
  // populated in any particular order.
  const importerOf = new Map<string, string>();

  /**
   * Module key -> that module's specifier classification, filled by the
   * `transform` hook below and read by `resolveId`.
   *
   * This is the answer to the one structural problem rule 2 has: `resolveId`
   * receives a specifier STRING and an importer path, never an AST, so it
   * cannot see for itself whether an import was type-only. The information
   * exists exactly once in the pipeline — in the module's PRE-esbuild
   * TypeScript source — so it is captured there and carried forward.
   *
   * Three routes were available; this is why the other two lost:
   *
   *  - Recognizing the POST-esbuild shape (`import {} from "P"`) from inside
   *    `resolveId`. Rejected as unsound, not merely awkward: esbuild emits the
   *    identical `import {} from "P"` for a genuine bare side-effect import
   *    under some settings, so the shape cannot separate "erased type import"
   *    from "the author asked for this package's side effects". That is a
   *    false NEGATIVE in a security fence — the one direction of error this
   *    gate must never make — and it would additionally depend on
   *    `getModuleInfo(importer).code` being populated during a dependency's
   *    `resolveId`, which is undocumented Rollup ordering.
   *  - Moving rule 2 wholesale into a `transform` pass. Rejected as too wide
   *    for this change: `transform` never runs for entry, virtual or
   *    externalized importers, so rule 2 would silently stop judging edges it
   *    judges today, and the import-chain machinery (`importerOf`) is built
   *    out of `resolveId`'s importer argument. Gate A is a `resolveId` fence
   *    by identity; only the type-only QUESTION moves, never the refusal.
   *  - Reusing `projection.ts`'s existing parse (`projectModule`). Rejected as
   *    a coupling, though it is the right TECHNIQUE and is copied here:
   *    projection parses only `*.page.tsx`/`layout`/`root`, records binding
   *    READERS rather than import KINDS, and rewrites code. Gate A must work
   *    standalone — every case in `gate-a-resolve.spec.ts` runs
   *    `gateAResolve()` with no projection in the array — so it cannot depend
   *    on another plugin having run.
   *
   * A module absent from this map (unparseable, never transformed, not JS/TS)
   * yields no `"type"` answer, so rule 2 refuses exactly as it does today.
   * Missing information fails CLOSED.
   */
  const importKindsByModule = new Map<string, Map<string, ImportKind>>();

  function recordImportKinds(code: string, id: string): void {
    const key = moduleKey(id);
    if (key.includes("\0")) return;
    if (!PARSEABLE_MODULE_EXTENSIONS.test(key)) return;
    if (!GOVERNED_SCOPE_MENTION.test(code)) return;

    const kinds = classifyImportKinds(code, key);
    if (!kinds) return;

    const existing = importKindsByModule.get(key);
    if (!existing) {
      importKindsByModule.set(key, kinds);
      return;
    }
    // Same path re-transformed (a query variant, or a watch rebuild): merge in
    // the same fail-closed direction `classifyImportKinds` uses internally.
    for (const [source, kind] of kinds) {
      if (kind === "value" || !existing.has(source)) existing.set(source, kind);
    }
  }

  function isTypeOnlyEdge(
    source: string,
    importer: string | undefined,
  ): boolean {
    if (!importer) return false;
    return importKindsByModule.get(moduleKey(importer))?.get(source) === "type";
  }

  /**
   * How many `resolve.alias` entries this build declares, captured from the
   * RESOLVED Vite config (`configResolved`) rather than guessed.
   *
   * Purely diagnostic, and it is the one thing the alias table can tell Gate A
   * that the resolver cannot. The gate does not match aliases itself — see the
   * note on the alias pass in `resolveId` for why asking Vite's own resolver
   * beats re-deriving `@rollup/plugin-alias`'s find/replacement semantics. But
   * when a specifier resolves to NOTHING, the count is the difference between
   * "a dependency is missing" and "this build never installed the alias table
   * its own tsconfig `paths` describe" — which is exactly the v5 production
   * client build's state, and the actionable half of that warning.
   *
   * `undefined` when `configResolved` never fired (plain Rollup, or a unit
   * harness), which the message reports as unknown rather than as zero.
   */
  let declaredAliasCount: number | undefined;

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
    /** Records the alias-table size; see `declaredAliasCount`. Judges nothing. */
    configResolved(config) {
      const alias: unknown = config.resolve?.alias;
      if (Array.isArray(alias)) {
        declaredAliasCount = alias.length;
      } else if (alias && typeof alias === "object") {
        declaredAliasCount = Object.keys(alias).length;
      } else {
        declaredAliasCount = 0;
      }
    },
    /**
     * The config-level half of rule 1 — see `externalizedBuiltins` for why a
     * `resolveId` fence cannot cover it on its own. Runs once per build, before
     * the first module is loaded, so the refusal lands before anything has been
     * bundled.
     */
    buildStart(inputOptions) {
      const externalized = externalizedBuiltins(inputOptions.external);
      if (externalized.length === 0) return;
      const shown = externalized.slice(0, 5).join(", ");
      const rest =
        externalized.length > 5 ? `, and ${externalized.length - 5} more` : "";
      this.error(
        [
          `Gate A refused this build: its Rollup "external" config would let Node builtins through the fence.`,
          ``,
          `Externalized builtins: ${shown}${rest}`,
          `Cause: Rollup consults "external" BEFORE any resolveId hook, so an externalized builtin is never offered to Gate A and is emitted into the browser chunk verbatim (e.g. import { readFileSync } from "node:fs"). No import of one has to exist yet — the configuration alone has already disabled rule 1.`,
          `Fix: remove the Node builtins from build.rollupOptions.external (keeping any non-builtin entries), and move the code that needs them into a *.server.ts file, a server/ folder, a loader, or a controller. If this build targets Node rather than the browser, it should not be running Gate A at all.`,
        ].join("\n"),
      );
    },
    /**
     * Records import kinds; never rewrites a byte (`null` return). `enforce:
     * "pre"` is what makes this correct as well as early — it puts this hook
     * ahead of Vite's own `vite:esbuild` TypeScript transform, so `code` here
     * is the ORIGINAL source with `type` modifiers still on it. After esbuild
     * the distinction no longer exists in the text.
     *
     * Runs before `resolveId` fires for any of this module's own specifiers:
     * Rollup must parse a module's post-transform source to discover what to
     * resolve next. That ordering is an OBSERVED Rollup behaviour, pinned by
     * `index.spec.ts`'s "D.3 hook ordering pin" and documented at length in
     * `index.ts`. If it ever inverts, this map is simply empty when
     * `resolveId` reads it and rule 2 goes back to refusing type-only imports
     * — a loud false positive, never a silent leak.
     */
    transform(code, id) {
      recordImportKinds(code, id);
      return null;
    },
    /**
     * The erased stand-in a type-only edge into a server-only package resolves
     * to. It must exist rather than the import simply being permitted, and the
     * fixture measures why: `import { type Request } from "@warlock.js/core"`
     * under `verbatimModuleSyntax` is emitted as `import {} from
     * "@warlock.js/core"`, and Rollup honours that as a side-effect edge — the
     * package's module-level code lands in the client chunk even though not one
     * binding is read from it. Permitting the import would therefore trade a
     * false positive for the exact silent leak the `server` marker exists to
     * close. Resolving to an empty module gives both: a clean build, and
     * nothing of the server package in the browser.
     */
    load(id) {
      return id === TYPE_ONLY_ERASED_ID ? "export {};" : null;
    },
    async resolveId(source, importer, resolveOptions) {
      // Gate A is a CLIENT-build fence — see the header note and Gate B/Gate
      // C's identical carve-outs (`gate-b-secrets.ts`'s `options?.ssr` guard
      // in `transform`, Gate C's `this.environment?.config?.consumer ===
      // "server"` in `generateBundle`). The SSR/server build resolves the
      // same specifiers this app's client build does — a server-only import
      // is exactly what that build is FOR — so refusing them there would
      // refuse the server its own legitimate dependencies. Judged first and
      // unconditionally: nothing below this line has a file to weigh in on
      // an SSR resolution before this returns.
      if (resolveOptions?.ssr) return null;

      // Compute the path Gate A judges: for relative/absolute specifiers,
      // resolve against the importer's directory ourselves (filename-only
      // check, zero AST parsing, per `c604f0bc` §4) rather than delegating
      // to Vite's resolver first, then complete the extension the author was
      // free to leave off — `path.resolve` alone yields `.../helper` for
      // `./helper`, which rule 4 does not recognize as code and therefore
      // never judges. `completeLocalModulePath` is a no-op for bare
      // specifiers, virtual ids and paths that already carry an extension.
      const isRelativeOrAbsolute =
        source.startsWith(".") || path.isAbsolute(source);
      const judgedPath = completeLocalModulePath(
        isRelativeOrAbsolute && importer
          ? path.resolve(path.dirname(importer), source)
          : source,
      );

      if (source === TYPE_ONLY_ERASED_ID) return source;

      const typeOnly = isTypeOnlyEdge(source, importer);

      const violation = ruleViolation(
        source,
        judgedPath,
        importer,
        environmentOf,
        appRoot,
        typeOnly,
      );
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

      // Not refused, but not an ordinary import either: rule 2's predicate
      // holds and only the missing value binding spared it. Asked here, AFTER
      // `ruleViolation` has run to completion, so rules 3 and 4 keep the last
      // word over a type-only specifier (`@warlock.js/core/db.server` is still
      // refused by rule 3, whatever the import kind).
      if (
        typeOnly &&
        isServerMarkedGovernedPackage(source, importer, environmentOf, appRoot)
      ) {
        return TYPE_ONLY_ERASED_ID;
      }

      // Not forbidden — resolve for real so the chain map reflects Rollup's
      // actual resolved ids, then hand that resolution back so we don't do
      // the work twice.
      const resolved = await this.resolve(source, importer, {
        ...resolveOptions,
        skipSelf: true,
      });
      if (resolved && importer) {
        importerOf.set(resolved.id, importer);
      }

      /*
        THE ALIAS PASS — rules 3 and 4, judged a SECOND time on the file the
        specifier actually reached rather than on the string that named it.

        Everything above judges `judgedPath`, which for a specifier that is
        neither relative nor absolute is the specifier STRING itself. That is
        the right answer for rules 1, 2 and 5, which judge names. It is the
        wrong answer for rules 3 and 4, which judge files — and it is why an
        import written in alias form (`app/users/...`) walked past both.

        Resolution, not re-derivation. The card that raised this asked for the
        alias TABLE to be read out of the config and applied here. Asking
        `this.resolve` is the same answer arrived at more cheaply and with
        strictly less to get wrong: it IS Vite's resolver, configured by that
        very table, so it already covers string-vs-RegExp `find` semantics,
        entry order, `customResolver`, extension completion and `index` files —
        every one of which is a place a second implementation of
        `@rollup/plugin-alias` could drift from the first. It also covers routes
        the table does not describe at all (a `vite-tsconfig-paths` plugin, a
        `customResolver`), which a table reader would miss.

        The `isAppSourcePath` pre-filter is what keeps this from being a second,
        broader rule: everything in `node_modules` and everything outside
        `appRoot` is out before `ruleViolation` is asked anything, exactly as
        rules 3 and 4 already require of their own subjects.

        WARNING, NOT REFUSAL — and this is the deliberate, temporary half. The
        judgement above is now spelling-independent; the consequence is not yet.
        Unlike the other fences in this file, turning this one on has a measured
        non-zero blast radius in application source that BUILDS TODAY, so a
        refusal would break working builds at sites nobody has surveyed. The
        warning names the file, the specifier and the resolved path so the
        survey can be taken; when it comes back empty, this `this.warn` becomes
        `this.error` and the alias pass folds into the pass above.
      */
      const isBareSpecifier = !isRelativeOrAbsolute && !source.includes("\0");
      if (isBareSpecifier && resolved && !resolved.external) {
        const aliasPath = completeLocalModulePath(moduleKey(resolved.id));
        if (isAppSourcePath(aliasPath, appRoot)) {
          const aliasViolation = ruleViolation(
            source,
            aliasPath,
            importer,
            environmentOf,
            appRoot,
            typeOnly,
          );
          if (aliasViolation) {
            this.warn({
              message: [
                `Gate A WOULD refuse this import — reported as a WARNING, not enforced yet.`,
                ``,
                `Import chain: ${[...buildChain(importer), source].join(" → ")}`,
                `File: ${importer ?? source}`,
                `Specifier: "${source}"`,
                `Resolves to: ${aliasPath}`,
                `Cause: ${aliasViolation.cause}`,
                `Fix: ${aliasViolation.fix}`,
                `Why only a warning: this specifier is written in ALIAS form. The identical import spelled relatively or absolutely is REFUSED today — the spelling was the only difference — and rules 3 and 4 have only just started judging this form. Every line like this is either an import to fix or a rule to correct; when there are none left, this becomes a refusal.`,
              ].join("\n"),
              id: importer,
            });
          }
        }
      }

      /*
        THE UNJUDGEABLE SPECIFIER — the shape that was actually measured on
        `v5/app`, and the one no amount of rule work inside this hook can judge.

        When nothing in the build resolves a bare specifier, Rollup does not
        fail: it warns `UNRESOLVED_IMPORT` and treats it as EXTERNAL, writing
        `import { x } from "app/users/resources/user.resource"` verbatim into
        the browser chunk. Measured on this gate's own fixture with an empty
        `resolve.alias`: build SUCCEEDED, emitted chunk carried the specifier
        untouched. That is the same failure mode `externalizedBuiltins` exists
        to close for rule 1, reached through a different door — an import that
        crosses into the client bundle without any rule ever having a file to
        judge.

        And it is not hypothetical: the v5 app declares `app/*` and `web/*` in
        its tsconfig `paths`, `web-connector.ts` installs the matching
        `resolve.alias` pair for the DEV server, and the production client build
        (`build-client.ts`, fed by `contribution.ts`'s `aliases ?? {}`) installs
        NOTHING — so in that build every alias-form import is unresolvable and
        externalized. The fix for that is a config wiring change in a file this
        gate does not own; what this gate can do is stop it being silent.

        Deliberately NOT a refusal and deliberately NOT a guess. Gate A will not
        invent `app/*` -> `<appRoot>/src/app/*` from the app convention: those
        prefixes are the application's to choose, and a fence that hard-codes
        them is wrong for the first app that names its trees differently.
      */
      if (isBareSpecifier && !resolved) {
        const aliasTable =
          declaredAliasCount === undefined
            ? `this build's resolve.alias was never reported to the gate`
            : `this build's resolve.alias declares ${declaredAliasCount} ${declaredAliasCount === 1 ? "entry" : "entries"}`;
        this.warn({
          message: [
            `Gate A could not judge this import — and it is going into the browser chunk unjudged.`,
            ``,
            `Import chain: ${[...buildChain(importer), source].join(" → ")}`,
            `File: ${importer ?? source}`,
            `Specifier: "${source}"`,
            `Cause: nothing in this build resolves "${source}", so Rollup treats it as an external dependency and writes the import statement into the client chunk verbatim. Rules 3 and 4 judge a FILE; with no resolution there is no file, so this import crossed the fence unexamined rather than being allowed by it (${aliasTable}).`,
            `Fix: if this is an app-convention alias specifier (a tsconfig "paths" entry such as app/* or web/*), give the CLIENT build the matching resolve.alias entry the dev server already installs, so the specifier resolves to a real file and Gate A can judge it. Otherwise install the missing package, or write the import relatively.`,
          ].join("\n"),
          id: importer,
        });
      }

      return resolved ?? null;
    },
  };
}
