/**
 * Standing up page serving for a BUILT application — the production half of
 * `WebConnector.boot()`, kept out of the connector so the mode branch there
 * stays one `if` and this path stays readable on its own.
 *
 * The development path answers "which pages exist?" by walking `app/` and
 * "what is this module?" by asking Vite to evaluate it. A production process
 * can ask neither question: there is no source tree beside the bundle and no
 * Vite. Both answers arrived at import time instead, in the generated pages
 * barrel's {@link PageManifest}, and everything below is what remains once
 * those two questions are already answered — a guard, a wiring step and a
 * registration step.
 *
 * NOTHING HERE REACHES FOR VITE, transitively included. `vite` is an optional
 * peer, so a production install does not carry it; an import that only ever
 * runs in development still fails at module load in production, which is why
 * the one import that has to happen at boot is a dynamic one and why it names
 * the pipeline barrel and nothing else.
 */
import type { Response } from "../../../core/src/http/response";
import type { Router } from "../../../core/src/router/router";
import type { SharedStoreResolver } from "../shared";
import type { BufferedCookie } from "./buffered-response";
import type { PageContextRunner } from "./execute-page-request";
import type { InstalledManifestPageRoute } from "./install-page-routes-from-manifest";
import type { PageManifest } from "./page-manifest";

/** The only export this module reads off a page module namespace. */
type PageModuleShape = {
  route?: unknown;
};

export type InstallProductionPageRoutesOptions = {
  router: Router;
  /** The table the generated production barrel provided at import time. */
  manifest: PageManifest;
  /**
   * Core's per-request context, handed over rather than imported: core is a
   * type-only peer of web, and two copies of core would mean two
   * AsyncLocalStorage stores and a page pipeline reading an empty one.
   */
  pageContext: PageContextRunner;
  /** Reads the current request's store out of {@link pageContext}. */
  sharedStore: SharedStoreResolver;
  /** Same helper `dev-server.ts` exports — passed in, never imported. */
  applyBufferedCookie: (response: Response, cookie: BufferedCookie) => void;
  /**
   * Where the browser fetches the hydration entry from.
   *
   * A THUNK, not a value: the URL is read out of the client build's manifest,
   * and a build that discovered no pages has no hydration entry for that read
   * to find. Deferring it means a page-free production bundle boots without
   * demanding a file it had no reason to emit.
   */
  resolveHydrationClientModuleUrl: () => string;
};

/**
 * A manifest page whose module namespace carries no `route` export.
 *
 * Page discovery only emits a module it read a `route` off, so a valid build
 * cannot produce this — a stale artifact or a hand-edited barrel can. The
 * alternative to refusing it is a page table that silently shrinks: the
 * operator gets a clean boot log and a 404 on a page that is demonstrably in
 * the bundle, with nothing anywhere naming the file. The file is named here
 * because it is the entire diagnosis.
 */
export class PageManifestEntryMissingRouteError extends Error {
  public constructor(sourceFile: string) {
    super(
      `Cannot serve pages: the page manifest entry for "${sourceFile}" has no \`route\` export, ` +
        "so it has no URL to be registered under. This build's generated `pages.ts` barrel does " +
        "not match the sources it was generated from — re-run `warlock build`, and if the page is " +
        "meant to be served, give it a `route` export.",
    );
    this.name = "PageManifestEntryMissingRouteError";
  }
}

/**
 * Refuse the whole table before any of it is registered.
 *
 * Checked in one pass UP FRONT rather than per page inside the registration
 * loop: a half-installed page table is worse than a refused boot, because it
 * serves.
 */
function assertEveryPageDeclaresRoute(manifest: PageManifest): void {
  for (const page of manifest.pages) {
    if ((page.module as PageModuleShape).route === undefined) {
      throw new PageManifestEntryMissingRouteError(page.sourceFile);
    }
  }
}

/**
 * Register every page the manifest carries, and connect the pipeline the
 * handlers will run in.
 *
 * An empty table registers nothing and is not an error: "built with web, no
 * pages" is a legal state of a built application, and it is also the one state
 * where there is no pipeline to connect and no hydration entry to point at, so
 * it returns before doing either.
 */
export async function installProductionPageRoutes(
  options: InstallProductionPageRoutesOptions,
): Promise<InstalledManifestPageRoute[]> {
  const {
    router,
    manifest,
    pageContext,
    sharedStore,
    applyBufferedCookie,
    resolveHydrationClientModuleUrl,
  } = options;

  assertEveryPageDeclaresRoute(manifest);

  if (manifest.pages.length === 0) return [];

  // Loaded at boot rather than statically, and through the BARREL: production
  // has one module graph, so the barrel's instance of the pipeline is the same
  // instance the manifest's page modules were linked against, and connecting
  // the request context on it connects it for every handler registered below.
  // Development cannot do this — its modules live in Vite's separate graph, and
  // it wires the same two seams on the copy Vite evaluated.
  const webServer = await import("./index");

  webServer.connectSharedStore(sharedStore);
  webServer.connectPageContext(pageContext);

  return webServer.installPageRoutesFromManifest({
    router,
    manifest,
    hydrationClientModuleUrl: resolveHydrationClientModuleUrl(),
    applyBufferedCookie,
  });
}
