import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePath, type EnvironmentModuleNode, type ViteDevServer } from "vite";

/**
 * Helpers shared by the development SSR bridges that make Vite read a module
 * through the native `file://` URL core's loader hook already evaluated
 * (`core-model-modules.ts` for models, `core-app-modules.ts` for `src/app`).
 */

const CODE_MODULE_EXTENSION = /\.[cm]?[jt]sx?$/;
const ASSET_QUERY = /[?&](?:raw|url)(?:&|$)/;

/**
 * The absolute path a Vite module id names, or `undefined` for an id that is
 * not a plain code file (virtual ids, `data:` ids, `?raw`/`?url` and every
 * other query except Vite's own `?t=<timestamp>`).
 */
export function moduleIdPath(id: string): string | undefined {
  if (id.startsWith("\0") || id.startsWith("data:")) return undefined;
  if (ASSET_QUERY.test(id)) return undefined;

  const [fileName, query] = id.split("?", 2);
  if (query !== undefined && !/^t=\d+$/.test(query)) return undefined;
  if (!CODE_MODULE_EXTENSION.test(fileName)) return undefined;

  try {
    return fileName.startsWith("file:") ? fileURLToPath(fileName) : path.resolve(fileName);
  } catch {
    return undefined;
  }
}

export function versionedUrl(url: string, generation: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}v=${generation}`;
}

export function isSsrEnvironment(
  context: { environment?: { config?: { consumer?: string } } },
  ssr?: boolean,
) {
  return ssr === true || context.environment?.config?.consumer === "server";
}

/**
 * A Vite SSR module that re-exports a native `file://` URL.
 *
 * The outer `data:` module is what Vite sees and externalizes; Node then
 * resolves the inner URL through core's loader hook, which stamps the current
 * version and returns the instance core already holds.
 */
export function trampoline(url: string, hasDefault: boolean): string {
  const defaultExport = hasDefault ? `\nexport { default } from ${JSON.stringify(url)};` : "";
  const nativeCode = `export * from ${JSON.stringify(url)};${defaultExport}`;
  const nativeUrl = `data:text/javascript,${encodeURIComponent(nativeCode)}`;
  const proxyDefault = hasDefault ? `\nexport { default } from ${JSON.stringify(nativeUrl)};` : "";

  return `export * from ${JSON.stringify(nativeUrl)};${proxyDefault}`;
}

export function invalidateWithImporters(
  server: ViteDevServer,
  file: string,
  ids: ReadonlySet<string>,
): void {
  const graph = server.environments.ssr.moduleGraph;
  const visited = new Set<EnvironmentModuleNode>();
  const invalidate = (current: EnvironmentModuleNode) => {
    if (visited.has(current)) return;
    visited.add(current);
    graph.invalidateModule(current, new Set(), Date.now(), true);
    for (const importer of current.importers) invalidate(importer);
  };

  for (const id of ids) {
    const module = graph.getModuleById(id);
    if (module) invalidate(module);
  }

  for (const module of graph.getModulesByFile(normalizePath(file)) ?? []) invalidate(module);
}
