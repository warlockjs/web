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
  };
}
