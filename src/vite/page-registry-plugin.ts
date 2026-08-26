/**
 * The wire between the two halves that already existed and never met:
 * `discoverPages` (the page graph, read off disk) and `generateClientRegistry`
 * (the module SOURCE that carries that graph into the browser). Neither one
 * touches Vite; this plugin is the only place they are joined, and it joins
 * them as a VIRTUAL module so nothing is ever written to the user's tree.
 *
 * Identical in dev and build — no `apply`/`command` gating, matching the rest
 * of `warlockClientBoundary`'s composition (`index.ts`), which is also
 * mode-agnostic. A registry that differed between `vite dev` and `vite build`
 * would make every dev-only or prod-only page bug unreproducible in the other
 * mode.
 */
import { parse } from "@babel/parser";
import MagicString from "magic-string";
import path from "node:path";
import type { Plugin } from "vite";
import { discoverPages, toPosix } from "../build/discover-pages";
import { generateClientRegistry } from "../build/generate-client-registry";
import { SERVER_EXPORT_NAMES } from "./projection";

/**
 * The specifier application code writes.
 *
 * Exported so the client runtime imports this constant instead of retyping the
 * string: a constant two sides must agree on is a guard, and a guard duplicated
 * at a second site fails open at the third — a typo'd re-spelling doesn't fail
 * loudly, it resolves to "no such module" or, worse, to a stale real file.
 */
export const CLIENT_PAGE_REGISTRY_ID = "virtual:warlock/pages";

/**
 * The resolved id, `\0`-prefixed per Vite/Rollup convention so no other plugin
 * (and no filesystem watcher) mistakes it for a real path.
 */
export const RESOLVED_CLIENT_PAGE_REGISTRY_ID = `\0${CLIENT_PAGE_REGISTRY_ID}`;

export type ClientPageRegistryPluginOptions = {
  /** Absolute path to the application root. Defaults to `process.cwd()`, matching Vite's own default `root` and Gate A's `appRoot` default. */
  appRoot?: string;
  /** Source directory name under `appRoot`; forwarded verbatim to `discoverPages`, which defaults it to `"src"`. */
  srcDir?: string;
};

/**
 * The import specifiers the emitted registry names must be ABSOLUTE POSIX file
 * paths, never relative ones.
 *
 * A relative specifier resolves against its IMPORTER, and the importer here is
 * `\0virtual:warlock/pages` — a synthetic id whose `dirname` is not a real
 * directory. `./blog.page.tsx` from that importer resolves to nonsense that
 * fails at bundle time with a path no user authored and no user can act on.
 *
 * Separator normalization is `hydration-entries.ts`'s
 * (`hydration-entries.ts:12-14`) and `discover-pages.ts`'s single
 * `.replace(/\\/g, "/")` rule, reused via the already-exported `toPosix` rather
 * than spelled a third time — keeping the drive colon (`D:/...`) is exactly
 * what Vite's resolver wants on Windows.
 */
function toImportSpecifier(absoluteFilePath: string): string {
  return toPosix(path.resolve(absoluteFilePath));
}

/**
 * Erases the generated module's TypeScript down to plain JavaScript.
 *
 * NOT optional, and not a style choice. Vite's `vite:esbuild` transform is
 * gated behind `createFilter`, which refuses ANY id containing a NUL byte
 * (`node_modules/vite/dist/node/chunks/config.js:1512` — `if
 * (id.includes("\0")) return false`). So the one module in this build that is
 * `\0`-prefixed by convention is precisely the one module esbuild will never
 * transform, while `generateClientRegistry` always emits TypeScript (a
 * type-only `ClientPageEntry` import plus the array's type annotation). Handed
 * to Rollup verbatim, `import type { ClientPageEntry } from ...` is a
 * JavaScript syntax error.
 *
 * Done with the AST rather than a regex, using the same `@babel/parser` +
 * `MagicString` pair `projection.ts` already uses in this directory — a regex
 * over generated source is a second grammar that drifts from the generator's
 * silently. If the generator ever emits a TS construct outside these two
 * shapes, the result is a Rollup parse error naming the virtual module: loud,
 * not silent. `page-registry-plugin.spec.ts` pins that the erased output
 * re-parses as plain JavaScript with the TypeScript plugin switched OFF.
 */
function eraseTypes(source: string): string {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const magic = new MagicString(source);

  for (const statement of ast.program.body as any[]) {
    if (statement.type === "ImportDeclaration" && statement.importKind === "type") {
      let end = statement.end as number;
      if (source[end] === "\r" && source[end + 1] === "\n") end += 2;
      else if (source[end] === "\n") end += 1;
      magic.remove(statement.start as number, end);
      continue;
    }

    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;

    if (declaration?.type !== "VariableDeclaration") continue;

    for (const declarator of declaration.declarations as any[]) {
      const annotation = declarator.id?.typeAnnotation;
      if (annotation) magic.remove(annotation.start as number, annotation.end as number);
    }
  }

  return magic.toString();
}

/**
 * The four file shapes that carry SERVER data (`metadata` chief among them)
 * and are therefore projected before the client graph forms — the exact set
 * `projection.ts`'s `isProjectableFile` matches, spelled here by BASENAME so
 * the two agree by construction on what "a server-side page module" is. A
 * change to one of these is the only kind of change whose SERVER half
 * (`metadata`, `loader`, …) can move without the client half moving at all.
 */
function isServerPageModule(file: string): boolean {
  const base = path.basename(file.split("?")[0]);
  if (/\.page\.tsx?$/.test(base)) return true;
  if (base === "layout.tsx" || base === "layout.ts") return true;
  if (/\.layout\.tsx?$/.test(base)) return true;
  if (base === "root.tsx") return true;
  return false;
}

/**
 * The server-vs-client reload seam.
 *
 * A page module carries TWO halves. The CLIENT half is the projected code the
 * browser actually runs; Fast Refresh can hot-swap it with zero reloads. The
 * SERVER half — `metadata`, `loader`, `route`, `middleware`, `validation`, plus
 * the imports/locals orphaned with them — is stripped by projection
 * (`projection.ts:49`) and set to `undefined` on hydration
 * (`client/hydrate-page.tsx`), so the browser never holds it and there is
 * nothing on the client to hot-swap. Its effect is felt only when SSR re-runs
 * and re-renders `<head>`; the honest way to apply a change to it is a full
 * document reload.
 *
 * THE RULING (canon `6b240682`), stated as the invariant it is:
 *
 *   FAST REFRESH ONLY WHEN THE ONLY CHANGES ARE INSIDE COMPONENT BODIES.
 *   EVERYTHING ELSE RELOADS.
 *
 * Concretely: any change to an import statement, to a module-level
 * declaration, or to a server export forces a full document reload — whether
 * or not the JSX moved in the same save.
 *
 * WHY AN OVER-APPROXIMATION, AND WHY NOBODY SHOULD "IMPROVE" IT BACK
 *
 * Two earlier cuts tried to name the server half EXACTLY and both shipped a
 * stale `<head>`:
 *
 *   1. Comparing only the projected CLIENT code. A save that changed the JSX
 *      *and* `metadata` moved the client half, which was read as proof that
 *      only the JSX moved. Mixed saves took the Fast Refresh branch.
 *   2. Adding the complement — the stripped server half, recovered by
 *      subsequence diff. `projection.ts:447-448` KEEPS an import when the
 *      client reads it, so an import read by BOTH `metadata` and the JSX
 *      lives in the projection and appears in NEITHER half exclusively.
 *      Change its specifier and the complement is byte-identical → Fast
 *      Refresh, stale `<title>`. Shared module-level LOCALS have the same
 *      shape, so extending the complement a third time is a third bug.
 *
 * Both failures were UNDER-approximations, and under-approximating is the
 * unsafe direction. A precise reachability analysis over shared imports and
 * locals is the correct answer and is a later refinement; getting it subtly
 * wrong reproduces this bug again. Over-approximating can only err toward
 * RELOADING. A needless reload costs component state; a missed one ships a
 * stale `<head>` and calls it a hot update.
 *
 * THE ACCEPTED COST, which is not a bug to be optimised away: editing a
 * module-level helper read only by the JSX now reloads.
 *
 * The skeleton has to be captured BEFORE the edit, because by the time
 * `hotUpdate` runs Vite has already hard-invalidated the module and cleared its
 * `transformResult` (`onFileChange` → `invalidateModule`, which runs before any
 * `hotUpdate` hook). The `transform` spy below is that capture: it runs first in
 * the client environment, records the skeleton, and returns nothing so
 * projection still performs the real transform.
 */
type SkeletonCache = Map<string, string>;

/**
 * What replaces a component body in the skeleton. Its content is irrelevant —
 * only that it is CONSTANT, so two sources that differ solely inside a masked
 * body serialise identically.
 */
const MASKED_COMPONENT_BODY = "/*warlock:component-body*/";

/** React's own convention, and the one `react-refresh` itself uses: components are PascalCase. */
function isComponentName(name: string | undefined): boolean {
  return typeof name === "string" && /^[A-Z]/.test(name);
}

/** The `body` node of a function-shaped expression/declaration, or `undefined` for anything else. */
function functionBody(node: any): any | undefined {
  if (!node) return undefined;
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    return node.body;
  }
  return undefined;
}

/**
 * Generic duck-typed identifier walk, the same shape `projection.ts`'s
 * `collectIdentifierNames` uses (it is not exported, and re-deriving one
 * OVER-collecting walk is safe here for the same reason it is safe there).
 *
 * Over-collecting — counting an object property key or a shadowing parameter
 * as a "read" — can only make the reachable set BIGGER, which can only UNMASK
 * more component bodies, which can only produce more reloads. The safe
 * direction.
 */
function collectIdentifierNames(node: unknown, names: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectIdentifierNames(item, names);
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.type !== "string") return;
  if (record.type === "Identifier" || record.type === "JSXIdentifier") {
    names.add((record as any).name);
  }
  for (const key of Object.keys(record)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
    if (key === "leadingComments" || key === "trailingComments" || key === "innerComments" || key === "extra") {
      continue;
    }
    collectIdentifierNames(record[key], names);
  }
}

/** The module-scope names a top-level statement binds (the `export` wrapper looked through). */
function topLevelBoundNames(stmt: any): Set<string> {
  const names = new Set<string>();
  const declaration = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
  if (!declaration) return names;
  if (declaration.type === "VariableDeclaration") {
    for (const declarator of declaration.declarations) {
      if (declarator.id?.type === "Identifier") names.add(declarator.id.name);
    }
  } else if (declaration.id?.type === "Identifier") {
    names.add(declaration.id.name);
  }
  return names;
}

/**
 * Every module-scope name reachable from one of the five server exports.
 *
 * Used ONLY to UNMASK: a PascalCase function that `metadata` or `loader` can
 * reach is not a component for this purpose, it is a server-side helper that
 * merely looks like one, and a change inside its body must reload. Seeded from
 * any top-level statement binding a `SERVER_EXPORT_NAMES` name — deliberately
 * looser than `projection.ts`'s own `isServerExportDeclaration` (no export
 * requirement, no single-declarator requirement), because seeding from MORE
 * statements can only unmask more, i.e. reload more.
 *
 * Fixpoint, not one pass, for the same reason projection's is: a server-only
 * helper can be reached only through another server-only helper.
 */
function serverReachableNames(body: any[]): Set<string> {
  const reached = new Set<string>();
  const declarations = body
    .filter((stmt) => stmt.type !== "ImportDeclaration")
    .map((stmt) => ({ stmt, names: topLevelBoundNames(stmt) }));

  for (const { stmt, names } of declarations) {
    let isServerExport = false;
    for (const name of names) {
      if (SERVER_EXPORT_NAMES.has(name)) isServerExport = true;
    }
    if (isServerExport) collectIdentifierNames(stmt, reached);
  }

  for (let changed = true; changed; ) {
    changed = false;
    for (const { stmt, names } of declarations) {
      let isReached = false;
      for (const name of names) {
        if (reached.has(name)) isReached = true;
      }
      if (!isReached) continue;
      const before = reached.size;
      collectIdentifierNames(stmt, reached);
      if (reached.size !== before) changed = true;
    }
  }

  return reached;
}

/**
 * The body node to mask for a top-level statement, or `undefined` if this
 * statement is not a component declaration.
 *
 * Recognised shapes, and only these:
 *   - `export default function () {…}` / `export default () => …` — the page
 *     component, whatever it is called.
 *   - `function Name() {…}` / `const Name = () => …` (PascalCase, optionally
 *     `export`ed) — a component declared alongside it.
 *
 * Everything else — `memo(...)`/`forwardRef(...)` wrappers, classes,
 * lowercase helpers, every server export — is left UNMASKED and therefore
 * compared byte-for-byte. That costs Fast Refresh on those shapes and buys the
 * guarantee; see this seam's header.
 */
function componentBodyToMask(stmt: any, serverReachable: Set<string>): any | undefined {
  if (stmt.type === "ExportDefaultDeclaration") return functionBody(stmt.declaration);

  const declaration = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt;
  if (!declaration) return undefined;

  const named = (name: string | undefined, node: any) =>
    isComponentName(name) && !serverReachable.has(name as string) ? functionBody(node) : undefined;

  if (declaration.type === "FunctionDeclaration") {
    return named(declaration.id?.name, declaration);
  }
  if (declaration.type === "VariableDeclaration" && declaration.declarations.length === 1) {
    const declarator = declaration.declarations[0];
    if (declarator.id?.type !== "Identifier") return undefined;
    return named(declarator.id.name, declarator.init);
  }
  return undefined;
}

/**
 * The module source with every component body replaced by a constant — the
 * ONE value the reload decision compares across an edit.
 *
 * Everything outside a component body survives verbatim: imports, module-level
 * declarations, all five server exports, and the comments and whitespace
 * between them. So the skeleton is unchanged iff the save touched nothing but
 * component bodies, which is exactly the ruling.
 *
 * Returns `undefined` when the source does not parse — a half-typed file whose
 * error Vite is already reporting from projection's real `transform`. The
 * caller leaves the cache holding the last GOOD skeleton, so the next
 * successful save is still compared against the right baseline.
 */
function captureSkeleton(code: string): string | undefined {
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] });
  } catch {
    return undefined;
  }

  const body = ast.program.body as any[];
  const serverReachable = serverReachableNames(body);
  const magic = new MagicString(code);

  for (const stmt of body) {
    const bodyNode = componentBodyToMask(stmt, serverReachable);
    if (!bodyNode) continue;
    const start = bodyNode.start as number;
    const end = bodyNode.end as number;
    if (end > start) magic.overwrite(start, end, MASKED_COMPONENT_BODY);
  }

  return magic.toString();
}

/**
 * Serves the client page registry at {@link CLIENT_PAGE_REGISTRY_ID}.
 *
 * Discovery runs INSIDE `load`, once per `load` call, and its result is NOT
 * cached across builds — the plugin holds no state at all. A registry cached
 * past the moment a page file appears is a page that silently 404s until
 * someone restarts the dev server, which is a far more expensive bug than
 * re-walking a source tree. Rollup calls `load` once per module per build, and
 * in dev Vite's module graph caches the transformed result until the module is
 * invalidated, so the walk is not per-request either way. (Invalidating that
 * dev-server cache when a page file is ADDED needs a `handleHotUpdate`/watcher
 * hook that belongs with the dev provider slice — see the followup.)
 *
 * `enforce: "pre"` and placed FIRST in `warlockClientBoundary`'s array — see
 * that function's comment in `index.ts` for why position is what it is, and
 * `page-registry-plugin.spec.ts` for the real-build proof that the pages this
 * module names still reach `projection()`.
 */
export function clientPageRegistry(options: ClientPageRegistryPluginOptions = {}): Plugin {
  const appRoot = path.resolve(options.appRoot ?? process.cwd());

  // Per-plugin-instance, so two composed pipelines never cross-contaminate.
  // Holds the last captured SKELETON (source with component bodies masked) of
  // each server page module the client environment transformed — the "before"
  // side of the comparison in `hotUpdate`. See `captureSkeleton` above.
  const skeletonCache: SkeletonCache = new Map();

  return {
    name: "warlock:client-page-registry",
    enforce: "pre",
    resolveId(source) {
      if (source === CLIENT_PAGE_REGISTRY_ID) return RESOLVED_CLIENT_PAGE_REGISTRY_ID;
      return undefined;
    },
    load(id) {
      if (id !== RESOLVED_CLIENT_PAGE_REGISTRY_ID) return undefined;

      const pages = discoverPages({ appRoot, srcDir: options.srcDir });

      return eraseTypes(generateClientRegistry({ pages, toImportSpecifier }));
    },
    /**
     * Capture-only spy. Records the SKELETON of every server page module the
     * CLIENT environment transforms, and returns nothing so projection's own
     * `transform` still does the real work. SERVE-ONLY:
     * `this.environment.mode !== "dev"` skips it during `vite build`, where
     * there is no `hotUpdate` to feed and the extra parse would be pure cost.
     */
    transform(code, id) {
      if (this.environment?.mode !== "dev") return undefined;
      if (!isServerPageModule(id)) return undefined;

      const skeleton = captureSkeleton(code);
      if (skeleton !== undefined) skeletonCache.set(id, skeleton);

      return undefined;
    },
    /**
     * Applies the ruling (canon `6b240682`): Fast Refresh ONLY when the only
     * changes are inside component bodies.
     *
     *   - Skeleton moved (an import, a module-level declaration, ANY server
     *     export — with or without a simultaneous JSX change) → full reload.
     *   - Skeleton unchanged → defer to Fast Refresh, zero reloads.
     *
     * Note what is NOT here: no attempt to name which half a shared import or
     * local belongs to. That question is what produced the two previous stale
     * `<head>` bugs; this seam refuses to answer it and reloads instead.
     * `hotUpdate` exists only on the dev server, so this is serve-only by
     * construction.
     */
    async hotUpdate(context) {
      // `create`/`delete` are page graph churn, not in-place edits — leave them
      // to Vite's normal handling (a new/removed module reloads on its own).
      if (context.type !== "update") return undefined;
      if (!isServerPageModule(context.file)) return undefined;

      const nextSource = await context.read();
      const next = captureSkeleton(nextSource);
      const prev = skeletonCache.get(context.file);

      // Refresh the cache for the next edit regardless of the decision below.
      if (next !== undefined) skeletonCache.set(context.file, next);

      // Could not parse the new source (Vite is already reporting that error),
      // or the client environment never transformed this module — which means
      // the browser is not holding this page, so there is no stale `<head>` to
      // ship and nothing a reload of some OTHER page would fix.
      if (next === undefined || prev === undefined) return undefined;

      // Anything outside a component body moved: the browser cannot hot-swap
      // it, so reload the document to re-run SSR and re-render `<head>`.
      // `path: "*"` matches Vite's own middleware-mode reload.
      if (prev !== next) {
        this.environment.hot.send({ type: "full-reload", path: "*" });

        // Empty module list: we've issued the update ourselves, so Vite should
        // not additionally push a Fast Refresh for the client module.
        return [];
      }

      // Only component bodies moved: defer to Vite's Fast Refresh with zero
      // reloads. A no-op re-save falls through the same harmless path.
      return undefined;
    },
  };
}
