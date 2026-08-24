/**
 * The production answer to "how do I load a page module".
 *
 * `createPageRouteHandler` takes loading a module as an INPUT
 * ({@link PageModuleLoader}) precisely so the two runtimes can answer it
 * differently. Dev hands it `moduleId => vite.ssrLoadModule(moduleId)`;
 * production has no Vite and nothing to evaluate — the generated `pages.ts`
 * barrel already imported every page, layout and the app root statically, and
 * {@link PageManifest} is the table those namespace objects arrived in. So the
 * production loader does not load anything: it is a LOOKUP over modules that
 * are already in memory, and this file is that lookup and nothing else.
 */
import type { PageModuleLoader } from "./create-page-route-handler";
import type { PageManifest } from "./page-manifest";

/**
 * Asked for a module this build does not contain.
 *
 * Hard failure, deliberately. Every alternative — returning `undefined`, an
 * empty namespace, or falling back to a dynamic import — turns a build that
 * shipped the wrong module table into a page that renders blank, or into a
 * production process reaching for source files that are not deployed. The id
 * is in the message because the whole diagnosis is "which id, and why is it
 * not in the table"; the count is there because zero entries means the build
 * discovered no pages at all, which is a different fault from a mismatch.
 */
export class PageModuleNotInManifestError extends Error {
  public constructor(moduleId: string, knownIdCount: number) {
    super(
      `Cannot serve a page module: "${moduleId}" is not in this build's page manifest ` +
        `(${knownIdCount} module(s) available). Module ids are the manifest's \`sourceFile\` ` +
        "values — app-root-relative POSIX paths, extension included — and must match exactly. " +
        "Re-run `warlock build` so the generated `pages.ts` barrel matches what is being served.",
    );
    this.name = "PageModuleNotInManifestError";
  }
}

/**
 * Build the loader for ONE manifest.
 *
 * Ids are compared by exact string equality against the `sourceFile` each
 * entry carries — no lowercasing, no separator swapping, no extension
 * stripping. Both sides of that comparison come from the same generator
 * (`generatePagesBarrel` writes every `sourceFile` through one
 * app-root-relative POSIX derivation), so any spelling difference is a real
 * disagreement about which file is meant, and a normalizer would only hide it.
 *
 * A layout shared by several pages appears once per chain it belongs to; the
 * generator emits one identifier per layout file, so every occurrence of an id
 * carries the same namespace object and re-registering it is a no-op.
 */
export function createPageModuleLoader(manifest: PageManifest): PageModuleLoader {
  const modulesById = new Map<string, Record<string, unknown>>();

  if (manifest.app) {
    modulesById.set(manifest.app.sourceFile, manifest.app.module);
  }

  for (const page of manifest.pages) {
    modulesById.set(page.sourceFile, page.module);

    for (const layout of page.layouts) {
      modulesById.set(layout.sourceFile, layout.module);
    }
  }

  // `async` so an unknown id surfaces as a rejection rather than a synchronous
  // throw: the handler awaits every module through one `Promise.all`, and a
  // loader that fails both ways depending on the reason is a loader callers
  // have to guard twice.
  return async (moduleId: string) => {
    const module = modulesById.get(moduleId);

    if (module === undefined) {
      throw new PageModuleNotInManifestError(moduleId, modulesById.size);
    }

    return module;
  };
}
