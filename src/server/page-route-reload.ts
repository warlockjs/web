import path from "node:path";
import type { Router } from "@warlock.js/core";
import type { ViteDevServer } from "vite";
import type { InstalledPageRoute, PageModuleShape } from "./install-page-routes";
import { resolvePageRouteIdentity } from "./install-page-routes";
import { isNotFoundPageFile } from "./not-found-page";
import type { PageFileChanges } from "./page-file-change";

function pathKey(file: string): string {
  const normalized = path.resolve(file).replace(/\\/g, "/");

  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Every real page file currently represented in the route table. This includes
 * a custom `404.page.tsx`, which is intentionally absent from the public page
 * table because it has no linkable URL of its own.
 */
export function registeredPageFiles(
  routes: ReturnType<Router["list"]>,
  appSrcRoot: string,
): string[] {
  const sourceRoot = path.dirname(appSrcRoot);

  return [
    ...new Set(
      routes
        .filter((route) => route.isPage && route.sourceFile && !route.sourceFile.startsWith("\0"))
        .map((route) => path.resolve(sourceRoot, route.sourceFile)),
    ),
  ];
}

/** Exact route-source owners replaced by a live page-table transaction. */
export function pageRouteSourceFiles(routes: ReturnType<Router["list"]>): string[] {
  return [
    ...new Set(
      routes
        .filter((route) => route.isPage && route.sourceFile)
        .map((route) => route.sourceFile),
    ),
  ];
}

/**
 * Inspect only in-place page edits. Vite's SSR graph is invalidated explicitly
 * before evaluation because core's file watcher and Vite's watcher have no
 * ordering contract. Component-only edits compare equal and stay in Fast
 * Refresh; route/name changes request an atomic table replacement.
 */
export async function pageRoutesNeedReplacement(
  changes: PageFileChanges,
  options: {
    vite: ViteDevServer;
    appSrcRoot: string;
    installedPages: readonly InstalledPageRoute[];
  },
): Promise<boolean> {
  let replace = changes.added.length > 0 || changes.removed.length > 0;

  const installedByFile = new Map(
    options.installedPages.map((page) => [pathKey(page.file), page] as const),
  );

  for (const file of changes.inspectionNeeded) {
    options.vite.environments.ssr.moduleGraph.onFileChange(file);
    const pageModule = (await options.vite.ssrLoadModule(file)) as PageModuleShape;

    // A valid 404 page has no route identity. Its component body remains Vite
    // HMR territory; adding an illegal route export must still enter the
    // transaction so the installer can reject it without touching live routes.
    if (isNotFoundPageFile(file)) {
      if (pageModule.route !== undefined) replace = true;
      continue;
    }

    const installed = installedByFile.get(pathKey(file));
    if (installed === undefined || pageModule.route === undefined) {
      replace = true;
      continue;
    }

    const next = resolvePageRouteIdentity(pageModule.route, file, options.appSrcRoot);
    if (next.declaredPath !== installed.declaredPath || next.name !== installed.name) {
      replace = true;
    }
  }

  return replace;
}
