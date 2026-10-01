import fs from "node:fs/promises";
import path from "node:path";
import { appConventionAliases } from "./app-convention-aliases";
import { collectImportSpecifiers } from "./ssr-client-view";

/**
 * Whether a `src/app` module may be handed to Node's loader, decided by a
 * static scan of its TRANSITIVE import graph.
 *
 * WHY THE GRAPH, NOT THE FILE. Handing a module to Node means everything it
 * imports is evaluated by Node too. If any module it reaches needs Vite, the
 * whole chain has to stay in Vite — and a module that stays in Vite can never
 * import a bridged one that imports it back, so the verdict propagates up to
 * every importer.
 *
 * WHAT NEEDS VITE, after auditing `web/src`:
 *   - `@warlock.js/web` (any subpath). Dev SSR deliberately inlines web into the
 *     Vite graph (`ssr.noExternal`) and wires its per-request state — `shared`'s
 *     store resolver (`shared.ts`), the page-context runner (`page-context.ts`),
 *     the request-search resolver (`query-string.ts`) — on THAT copy only
 *     (`web-connector.ts`, `connectSharedStore`). A native copy is unconnected,
 *     and its classes fail `instanceof` against the pipeline's (`PublicPageError`,
 *     `PageRedirectSignal`), its React contexts are different objects, and its
 *     module-local `WeakMap`s (`linkStylesheetsFor`) are never read.
 *   - Anything under `src/web/**`: that tree is Vite's (React, projection, HMR);
 *     a native import of it is a second instance of a Vite-evaluated module.
 *   - Source Vite alone can evaluate (`import.meta.env|glob|hot`, queried or
 *     non-code imports) — see {@link requiresViteToEvaluate}.
 *   - Anything the scan cannot prove safe: an unreadable file, source that does
 *     not parse, or a relative / convention-alias import that does not resolve.
 *
 * Only relative specifiers and the `app/` / `web/` convention aliases are
 * followed. Any other bare specifier is taken to be a package (so `@warlock.js/*`
 * other than web, which are shared external singletons, stay native).
 */

const WEB_PACKAGE = /^@warlock\.js\/web(?:\/|$)/;

const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx"];
const CODE_FILE = /\.[cm]?[jt]sx?$/;

/** A `.js` specifier names the `.ts` file next to it, the same way the loader hook probes. */
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".mjs": [".mts"],
  ".jsx": [".tsx"],
};

type FileInfo = {
  /** Needs Vite by its own text or by an import the scan could not follow. */
  readonly needsVite: boolean;
  /** Files this one imports that the scan can follow. */
  readonly imports: readonly string[];
};

export type AppModuleGraphScanOptions = {
  /** Absolute `<appRoot>/src`. */
  appSrcRoot: string;
  /** Source text that only Vite can evaluate; injected to avoid a module cycle. */
  requiresViteToEvaluate: (source: string) => boolean;
};

export type AppModuleGraphScanner = {
  /** True when `file`, or anything it reaches, must stay in Vite's graph. */
  staysInVite(file: string): Promise<boolean>;
  /** Drop what is cached about `file`; call when core bumps it. */
  forget(file: string): void;
};

function keyOf(file: string): string {
  return path.resolve(file).replaceAll("\\", "/").toLowerCase();
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function resolveLocalFile(base: string): Promise<string | undefined> {
  const extension = path.extname(base);
  const candidates: string[] = [];

  if (CODE_FILE.test(base)) {
    candidates.push(base);

    for (const swap of JS_TO_TS[extension] ?? []) {
      candidates.push(base.slice(0, -extension.length) + swap);
    }
  } else {
    // `./x.service` has an "extension" that is part of the name, so probe both.
    candidates.push(base);
    for (const ext of RESOLVABLE_EXTENSIONS) candidates.push(base + ext);
    for (const ext of RESOLVABLE_EXTENSIONS) candidates.push(path.join(base, `index${ext}`));
  }

  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }

  return undefined;
}

export function createAppModuleGraphScanner(
  options: AppModuleGraphScanOptions,
): AppModuleGraphScanner {
  const webDirectory = path.resolve(options.appSrcRoot, "web");
  const conventionAliases = appConventionAliases(path.resolve(options.appSrcRoot));
  const infoByFile = new Map<string, Promise<FileInfo>>();
  const verdictByFile = new Map<string, Promise<boolean>>();

  function isInsideWebDirectory(file: string): boolean {
    const relative = path.relative(webDirectory, file);

    return !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  /** `undefined`: a package, not ours to follow. `null`: ours, but unresolvable. */
  async function resolveSpecifier(
    specifier: string,
    importer: string,
  ): Promise<string | null | undefined> {
    const withoutQuery = specifier.split("?", 1)[0] ?? specifier;
    let base: string | undefined;

    if (withoutQuery.startsWith(".")) {
      base = path.resolve(path.dirname(importer), withoutQuery);
    } else if (path.isAbsolute(withoutQuery)) {
      base = withoutQuery;
    } else {
      for (const alias of conventionAliases) {
        if (alias.find.test(withoutQuery)) {
          base = withoutQuery.replace(alias.find, alias.replacement);
          break;
        }
      }
    }

    if (base === undefined) return undefined;

    return (await resolveLocalFile(path.normalize(base))) ?? null;
  }

  async function readInfo(file: string): Promise<FileInfo> {
    let source: string;

    try {
      source = await fs.readFile(file, "utf8");
    } catch {
      return { needsVite: true, imports: [] };
    }

    if (options.requiresViteToEvaluate(source)) return { needsVite: true, imports: [] };

    let specifiers: Set<string>;

    try {
      specifiers = collectImportSpecifiers(source);
    } catch {
      // Cannot prove what it imports, so it cannot be proven safe.
      return { needsVite: true, imports: [] };
    }

    const imports: string[] = [];

    for (const specifier of specifiers) {
      if (WEB_PACKAGE.test(specifier)) return { needsVite: true, imports: [] };

      const resolved = await resolveSpecifier(specifier, file);

      if (resolved === undefined) continue;
      if (resolved === null || isInsideWebDirectory(resolved)) {
        return { needsVite: true, imports: [] };
      }
      if (CODE_FILE.test(resolved)) imports.push(resolved);
    }

    return { needsVite: false, imports };
  }

  function infoOf(file: string): Promise<FileInfo> {
    const key = keyOf(file);
    let info = infoByFile.get(key);

    if (!info) {
      info = readInfo(file);
      infoByFile.set(key, info);
    }

    return info;
  }

  async function walk(root: string): Promise<boolean> {
    const visited = new Set<string>();
    const pending = [root];

    while (pending.length > 0) {
      const file = pending.pop() as string;
      const key = keyOf(file);

      if (visited.has(key)) continue;
      visited.add(key);

      const info = await infoOf(file);

      if (info.needsVite) return true;
      pending.push(...info.imports);
    }

    return false;
  }

  return {
    staysInVite(file) {
      const key = keyOf(file);
      let verdict = verdictByFile.get(key);

      if (!verdict) {
        verdict = walk(file);
        verdictByFile.set(key, verdict);
      }

      return verdict;
    },
    forget(file) {
      infoByFile.delete(keyOf(file));
      // A verdict covers the whole subgraph, so any edit can change any of them.
      verdictByFile.clear();
    },
  };
}
