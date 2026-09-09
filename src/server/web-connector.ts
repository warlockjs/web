/**
 * `WebConnector` — the SSR page surface as a first-class Warlock connector.
 *
 * It runs BESIDE `HttpConnector`, never instead of it: `warlock dev` alone now boots the API *and* serves React
 * pages on one port, and `web` no longer owns a private copy of the HTTP
 * lifecycle. Everything this file does used to live in `startDevServer()`
 * (`web/src/server/dev-error-transport.ts`), which created its own Fastify instance,
 * scanned the router and called `listen()` itself — three responsibilities core
 * already owns at `core/src/connectors/http-connector.ts:72`, `:133` and `:147`.
 *
 * WHY A `Late` CONNECTOR IS THE RIGHT SEAM, in ordering terms:
 * `ConnectorsManager.startPhase` runs **every** `boot()` in a phase before
 * **any** `start()` (`core/src/connectors/connectors-manager.ts:87-93`).
 * `HttpConnector` is itself `Late` (`core/src/connectors/http-connector.ts:41`)
 * and publishes its Fastify instance during its own `boot()`
 * (`container.set("http.server", …)`, `core/src/connectors/http-connector.ts:74`).
 * So by the time this connector's `boot()` runs, Fastify and its plugins exist,
 * the raw node server exists, and NOTHING has been scanned or bound yet — page
 * routes registered here are picked up by `HttpConnector.start()`'s
 * `router.scanDevServer(…)` (`core/src/connectors/http-connector.ts:133`) before
 * `listen()` (`:147`). `SocketConnector.boot()` reads the same container key the
 * same way (`core/src/connectors/socket-connector.ts:78-80`) — this file is
 * deliberately shaped after it.
 *
 * What it can NOT do, and why that is fine: route COLLECTION happens earlier
 * (`core/src/dev-server/development-server.ts:57` precedes `:66`), so pages are
 * not discovered by the framework's file scanner. They are discovered here, by
 * `installPageRoutes` (`./install-page-routes.ts:189`), and registered through
 * the ordinary `router.get(…)` API — there is no second server matcher.
 *
 * DELIBERATE EXCEPTION to A.3 §2 ("web has no core dependency"), the same one
 * `./dev-error-transport.ts` and `./install-page-routes.ts` record in their own headers:
 * this module is not re-exported from any package barrel (`web/src/index.ts`,
 * `web/src/server/index.ts`, `web/src/connector/index.ts`) and is not part of
 * `web/package.json`'s dependency graph. It is dev/CLI bootstrap code, only
 * ever imported by tooling that already depends on core.
 *
 * `@warlock.js/web/connector` reaches this class ONLY through
 * `./web-connector-factory.ts`'s `await import("./web-connector")` — a
 * deliberate seam, because a static edge from that barrel to this file would
 * put `../vite`, core's router and `./dev-error-transport` into the import graph of
 * every consuming app's `warlock.config.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";
import type { Alias, PluginOption, ViteDevServer } from "vite";
import {
  Application,
  BaseConnector,
  ConnectorLifecyclePhase,
  type ConnectorName,
  container,
  type FastifyInstance,
  requestContext,
  router,
} from "@warlock.js/core";
import { resolveWebPackageRoot } from "../build/contribution";
import { createHydrationClientEntry, invalidateClientPageRegistry } from "../vite";
import { createWebConnectorViteConfig } from "../vite/dev-server-config";
import { CLIENT_ASSET_URL_PREFIX } from "./client-asset-url-prefix";
import { devErrorTransportPlugin, sendCapturedDevError } from "./dev-error-transport";
import { resolveHydrationClientUrl } from "./hydration-client-url";
import type { InstalledPageRoute } from "./install-page-routes";
import { installProductionPageRoutes } from "./install-production-page-routes";
import {
  classifyPageFileChanges,
  hasPageFileChanges,
  type PageFileChanges,
} from "./page-file-change";
import {
  pageRouteSourceFiles,
  pageRoutesNeedReplacement,
  registeredPageFiles,
} from "./page-route-reload";
import { consumePageManifest, type PageManifest } from "./page-manifest";
import { registerProductionPublicFiles } from "./register-production-public-files";
import { createUnregisteredPageReporter } from "./unregistered-pages";
import { WEB_CONNECTOR_PRIORITY } from "./web-connector-factory";

/**
 * Boot/shutdown position relative to core's own connectors.
 *
 * `ConnectorPriority.HTTP` is `5` and `ConnectorPriority.STORAGE` is `6`
 * (`core/src/connectors/types.ts:187-188`), and the manager sorts on a plain
 * numeric compare (`core/src/connectors/connectors-manager.ts:46`) — so `5.5`
 * is "immediately after http, before everything else". Two consequences, both
 * wanted:
 *
 *  - `boot()` sees a Fastify instance that already has core's plugins and
 *    health routes on it (`core/src/connectors/http-connector.ts:76`, `:85`).
 *  - teardown is reverse-priority (`core/src/connectors/connectors-manager.ts:118`),
 *    so Vite closes BEFORE the HTTP server does, not after.
 *
 * Note this is a magic number, not a declared dependency: core has no
 * `after`/`dependsOn` on the connector interface (`core/src/connectors/types.ts:8-71`).
 * Ordering only *needs* to be right for shutdown — `boot()` correctness is
 * guaranteed by the phase's boot-all-then-start-all pass regardless of priority.
 *
 * Declared in `./web-connector-factory` and re-exported here: the lazy delegate
 * that `webConnector()` returns must publish `priority` without loading this
 * (heavy) module. Importers keep the specifier they already use.
 */
export { WEB_CONNECTOR_PRIORITY };

/**
 * Production boot ran with no page manifest in the registry.
 *
 * `undefined` from `consumePageManifest()` is a FACT, not an error — the registry never throws
 * on absence. The connector supplies the meaning, and it does so from MODE, not
 * from the value: in dev the absence is normal because Vite supplies the
 * modules and no build has run; in production it means the app was not built
 * with web, and a prod server that boots anyway serves 404s while looking
 * healthy — the exact silent failure this error exists to prevent.
 */
/**
 * Which half of the handoff is live: Vite serving from source, or a bundle
 * produced by `warlock build`.
 *
 * RUNTIME STRATEGY, NOT `Application.environment`. The two are explicitly a
 * "separate axis" (`core/src/utils/environment.ts:4-7`), and the question this
 * connector asks — "is there a page manifest, or does Vite supply the modules?"
 * — is a HOSTING question. `warlock dev` with `NODE_ENV=production` (a staging
 * checkout, or just an inherited shell variable) is still Vite-hosted and still
 * has no manifest; keying off the environment would make that app refuse to
 * boot. Core sets the strategy on both sides deliberately:
 * `core/src/cli/commands/dev-server.command.ts:12` declares `"development"` for
 * `warlock dev`, and the generated production entry declares `"production"`
 * (`core/src/production/production-builder.ts:245`).
 *
 * This is core's own connector-level idiom, not a new one:
 * `core/src/connectors/http-connector.ts:132` picks `scanDevServer` over `scan`
 * the same way.
 */
function isProductionRuntime(): boolean {
  return Application.runtimeStrategy === "production";
}

function pageFileVersion(file: string): string {
  try {
    return `present:${fs.readFileSync(file, "utf8")}`;
  } catch {
    return "absent";
  }
}

function pageChangeVersions(changes: PageFileChanges): Map<string, string> {
  return new Map(
    [...changes.added, ...changes.removed, ...changes.inspectionNeeded].map((file) => {
      const absoluteFile = path.resolve(file);
      return [absoluteFile, pageFileVersion(absoluteFile)] as const;
    }),
  );
}

export class WebPageManifestMissingError extends Error {
  public constructor() {
    super(
      "WebConnector booted in production without a page manifest. The generated " +
        "`pages.ts` barrel never ran, so no page modules were handed to the connector " +
        "and there is nothing to serve. Run `warlock build` with the web connector " +
        "registered in `warlock.config.ts > connectors`, and start the artifact that " +
        "build produced.",
    );
    this.name = "WebPageManifestMissingError";
  }
}

/**
 * The manifest carried browser artifacts but no `clientDir`.
 *
 * The build bakes that field in beside the page table, so the only way to
 * observe this is a VERSION SPLIT: an artifact produced by a `@warlock.js/web`
 * older than the field, started against a newer runtime. Named rather than
 * left to `path.resolve(cwd, undefined)`, which throws a `TypeError` naming
 * neither the manifest nor the rebuild that fixes it.
 */
export class WebClientDirMissingError extends Error {
  public constructor() {
    super(
      "The page manifest carries pages or public files but no `clientDir`, so the " +
        "connector cannot " +
        "locate the browser artifacts. This artifact was built by an older @warlock.js/web " +
        "than the one now running it. Re-run `warlock build` to regenerate the " +
        "`pages.ts` barrel against the current version.",
    );
    this.name = "WebClientDirMissingError";
  }
}

/**
 * `@fastify/static`'s `maxAge` is milliseconds (the `send` package's option,
 * not seconds like `Cache-Control`'s own `max-age`) — one year, matching the
 * header this produces: `public, max-age=31536000, immutable`. Safe forever
 * because every filename under {@link CLIENT_ASSET_URL_PREFIX} is content-hashed
 * by the client build: a changed file is a changed URL, never a changed
 * response at the same URL, which is the one condition `immutable` requires.
 */
const HASHED_ASSET_CACHE_MAX_AGE_MS = 31536000 * 1000;

/**
 * Exported so a test can assert the real options this connector hands
 * `router.directory` — the same object `boot()` uses below, not a copy a spec
 * could drift from unnoticed.
 */
export function productionAssetsDirectoryOptions(clientDir: string) {
  return {
    root: path.join(clientDir, "assets"),
    prefix: `${CLIENT_ASSET_URL_PREFIX}/`,
    maxAge: HASHED_ASSET_CACHE_MAX_AGE_MS,
    immutable: true,
  };
}

export type WebConnectorOptions = {
  /**
   * Vite's `root` — the application directory that owns `src/`, `package.json`
   * and `tsconfig.json`. Rooting Vite at the APP (not at the `web` package) is
   * what makes the app's own bare specifiers and dependency-optimizer scan
   * resolve correctly. Defaults to `process.cwd()`, which is where `warlock dev`
   * already runs.
   */
  appRoot?: string;
  /** `<appRoot>/src` by default. Pages are `<appSrcRoot>/app/**\/*.page.tsx`. */
  appSrcRoot?: string;
  /** The single global app-root file. `<appSrcRoot>/web/root.tsx` by default. */
  appFile?: string;
  /**
   * Root of the `@warlock.js/web` package, used to locate the hydration client
   * entry. Derived from this module's own location by default — a caller only
   * sets it when the package is not laid out normally.
   */
  webRoot?: string;
  /**
   * Extra `resolve.alias` entries, prepended to the app-convention aliases
   * (`web/*` → `src/web`, `app/*` → `src/app`) so a caller can win a conflict.
   * A normal application needs none of these; a monorepo checkout with unbuilt
   * workspace packages does.
   */
  resolveAlias?: Alias[];
  /** Extra `ssr.external` entries, appended to {@link CORE_OPTIONAL_PEERS}. */
  ssrExternal?: string[];
  /** Extra Vite plugins, appended after the client-boundary gates. */
  plugins?: PluginOption[];
};

/**
 * Web Connector
 * Manages the Vite dev server and the SSR page routes, mounted on the HTTP
 * connector's Fastify instance.
 */
export class WebConnector extends BaseConnector {
  public readonly name: ConnectorName = "web";
  public readonly priority = WEB_CONNECTOR_PRIORITY;
  public readonly lifecyclePhase = ConnectorLifecyclePhase.Late;

  /**
   * Nothing. Core already supplies each watcher batch to `shouldRestart`; page
   * membership and route identity are classified there, while component and
   * layout body edits remain Vite's HMR domain.
   */
  protected readonly watchedFiles: string[] = [];

  protected readonly options: WebConnectorOptions;

  protected vite?: ViteDevServer;

  protected installedPages: InstalledPageRoute[] = [];

  /**
   * The build→runtime handoff table, read once at boot.
   *
   * `undefined` in dev is the normal case and carries no meaning beyond "no
   * build has run" — see {@link WebPageManifestMissingError} for why the
   * production reading is a hard error and why the branch is on MODE.
   */
  protected pageManifest?: PageManifest;

  /**
   * The paths the DEVELOPMENT boot resolved, kept so `shouldRestart` can decide
   * whether a changed file is a page without re-deriving (and re-proving) the
   * web package root on every watcher batch. `undefined` in production and
   * before boot, which is exactly when `shouldRestart` must answer `false`.
   */
  protected resolvedPaths?: Awaited<ReturnType<WebConnector["resolvePaths"]>>;

  /** Synchronous watcher classification handed to the async reload phase. */
  protected pendingPageChanges?: PageFileChanges;

  /** Reuses Vite's pipeline-barrel module instance for every dev reinstall. */
  protected installDevPageRoutes?: () => Promise<InstalledPageRoute[]>;

  /** Serializes Vite and core watcher callbacks that can observe the same edit. */
  protected pageRouteReloadQueue: Promise<unknown> = Promise.resolve();

  /** Committed file versions awaiting the overlapping watcher callback. */
  protected pendingHotUpdateSuppressions = new Map<string, string>();

  public constructor(options: WebConnectorOptions = {}) {
    super();
    this.options = options;
  }

  /**
   * Boot the connector — wire the page pipeline's request context and register
   * every page on the router.
   *
   * Two ways of doing that, one per hosting mode, and they share the shape
   * rather than the mechanism. Development creates Vite in middleware mode,
   * mounts it on the HTTP connector's Fastify instance and discovers pages by
   * walking `app/`; production takes both answers from the manifest the build
   * handed over (`./install-production-page-routes`) and touches no Vite at all.
   *
   * Everything here happens BEFORE `HttpConnector.start()` scans and listens,
   * which is the entire reason this is a `Late` connector's `boot()` and not its
   * `start()`.
   */
  public async boot() {
    // THE MODE BRANCH. One `if`, and it reads the mode — never the value.
    // `consumePageManifest()` returning `undefined` must not mean two different
    // things at one call site, so the only
    // question asked of the value here is "is it there", and the only thing
    // that decides whether that matters is {@link isProductionRuntime}.
    this.pageManifest = consumePageManifest();

    if (isProductionRuntime() && !this.pageManifest) {
      throw new WebPageManifestMissingError();
    }

    // The manifest is guaranteed present by the guard above; naming it again is
    // what narrows the type, not a second check of the same condition.
    if (isProductionRuntime() && this.pageManifest) {
      // Gated on `clientDir`, never on `publicFiles.length`: a zero-page,
      // zero-public-file build legitimately carries no `clientDir` at all (see
      // `resolveClientDir`'s note), and calling this without one would demand
      // a client build that had no reason to exist. But once a `clientDir` IS
      // present — a client build actually ran — registering an EMPTY
      // `publicFiles` is free (the loop inside is a no-op) and the staleness
      // check this runs (`warnIfPublicBuildIsStale`) is most needed exactly
      // here: an app that shipped a build with NO public files still needs a
      // file added to `public/` afterwards to be caught, not 404 in silence
      // because a length check skipped the call that would have named it.
      if (this.pageManifest.clientDir !== undefined) {
        registerProductionPublicFiles(
          router,
          this.resolveClientDir(),
          this.pageManifest.publicFiles ?? [],
        );
      }

      this.installedPages = await installProductionPageRoutes({
        router,
        manifest: this.pageManifest,
        pageContext: requestContext,
        sharedStore: () => requestContext.getStore(),
        // The URL is resolved lazily, by the production path, only if there are
        // pages to hydrate — see the option's own note.
        resolveHydrationClientModuleUrl: () => this.resolveHydrationClientModuleUrl(),
        // The stylesheets are read from the manifest in this directory, by the
        // installer itself — it already imports the barrel that owns that
        // reader, and production has one module graph, so resolving there
        // rather than here avoids loading the barrel twice.
        clientDir: this.pageManifest.clientDir,
      });

      // SERVE THE CLIENT BUNDLE. Without this the whole production page path
      // completes and still ships a dead page: the SSR HTML carries
      // `<script type="module" src="/assets/hydration-<hash>.js">`, that request
      // 404s, and React never takes over. Nothing else in the process serves
      // that directory — `CLIENT_ASSET_URL_PREFIX` was, until now, only ever
      // read to VALIDATE the URL written into the HTML, never to mount the
      // files it points at.
      //
      // In `boot()` rather than `start()` because the router registers static
      // directories during its SCAN, and the scan is `HttpConnector.start()` —
      // which every `boot()` precedes. Registering in `start()` would be a
      // no-op that looked correct.
      //
      // Dev needs no equivalent: Vite's middleware serves the module graph
      // itself, which is why this sits inside the production branch and not
      // above it.
      //
      // Gated on the page count for the same reason the build's hydration
      // client step is: a zero-page build produces no `assets/` bundle to
      // mount. Such a build may still carry `clientDir` for copied public
      // files, which were registered individually above rather than exposing
      // this directory wholesale.
      if (this.pageManifest.pages.length > 0) {
        router.directory(productionAssetsDirectoryOptions(this.resolveClientDir()));
      }

      return;
    }

    // Everything below this line is the Vite-hosted development path. Nothing
    // above it touches Vite: it is an optional peer, so a production install
    // does not carry it, and this method is the only place the two halves meet.
    //
    // Fastify is required by the DEVELOPMENT path alone, and the guard sits
    // here rather than above the branch for that reason: production mounts no
    // middleware and needs no HMR socket, it registers page routes on the
    // router and `HttpConnector.start()` scans them like any other route.
    const fastify = this.resolveFastify();
    const paths = await this.resolvePaths();

    // Kept for `shouldRestart`, which is asked of this connector on every
    // watcher batch and must answer without re-resolving anything.
    this.resolvedPaths = paths;

    this.vite = await this.createViteServer(fastify, paths);

    // The pipeline barrel is loaded THROUGH VITE, not imported directly, and
    // that is load-bearing: page modules are evaluated inside Vite's SSR module
    // graph, so `connectSharedStore`/`connectPageContext` must be called on
    // VITE's instance of those modules. A plain Node `import` here would wire a
    // second, unrelated module instance and every page would render with an
    // empty shared store.
    const webServerSsr = await this.vite.ssrLoadModule(paths.webServerBarrel);

    webServerSsr.connectSharedStore(() => requestContext.getStore());
    webServerSsr.connectPageContext(requestContext);

    // Vite's `middlewares` is a plain Connect `(req, res, next)` stack and
    // Fastify's `request.raw`/`reply.raw` ARE node's `req`/`res`, so an
    // `onRequest` hook mounts it with no plugin at all — `@fastify/middie` is
    // not needed and is not a core dependency (`core/package.json`). Vite never
    // fronts the server: it either answers its own asset request or calls
    // `done()` and Warlock's router owns the response.
    //
    // ONE EXCEPTION, and it is why `done` is wrapped rather than passed
    // straight through: vite reaches this callback for TWO different reasons in
    // middleware mode — "not mine" and "mine, and it failed". The second one
    // arrives indistinguishable from the first, because vite's own error
    // handler logs the failure and then calls `next()` with the error cleared
    // (`node_modules/vite/dist/node/chunks/config.js:9525-9527`). Handing that
    // to the framework produced an empty 404 on a module that exists — via the
    // app's catch-all page route (`./render-page.ts:604`,
    // `./create-page-route-handler.ts:147`) — and threw the only useful
    // explanation away. `devErrorTransportPlugin` captures it upstream; this
    // reads it back.
    // Dev-only on both sides — nothing below this line runs in production.
    fastify.addHook(
      "onRequest",
      (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => {
        this.vite?.middlewares(request.raw, reply.raw, (error?: Error) => {
          if (sendCapturedDevError(request.raw, reply.raw)) return;

          done(error);
        });
      },
    );

    const reportUnregisteredPages = createUnregisteredPageReporter({
      appRoot: paths.appRoot,
      appSrcRoot: paths.appSrcRoot,
      registeredPageFiles: () => registeredPageFiles(router.list(), paths.appSrcRoot),
    });

    fastify.addHook(
      "onResponse",
      (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => {
        if (reply.statusCode === 404) {
          reportUnregisteredPages({
            method: request.method,
            url: request.url,
            pathname: new URL(request.url, "http://warlock.local").pathname,
          });
        }

        done();
      },
    );

    this.installDevPageRoutes = () =>
      webServerSsr.installPageRoutes({
        router,
        vite: this.vite,
        appSrcRoot: paths.appSrcRoot,
        appFile: paths.appFile,
        appRoot: paths.appRoot,
        hydrationClientModuleUrl: this.resolveHydrationClientModuleUrl(paths.webRoot),
        // Resolved here, on the NODE side, and forwarded — see
        // `InstallPageRoutesOptions.httpServer` (`install-page-routes.ts`) for
        // why `createPageRouteHandler` cannot read this out of the container
        // itself from inside Vite's SSR module graph. `fastify` is this same
        // request's `resolveFastify()` result, already in scope above.
        httpServer: fastify,
      });

    this.installedPages = await this.installDevPageRoutes();
  }

  /**
   * Where the browser fetches the hydration entry from — the one line that
   * differs between the two modes, so it is the only thing that branches.
   *
   * Dev keeps Vite's `/@fs/` URL, which Vite's own middleware transforms on
   * demand. Production reads the hashed filename out of the client build's
   * `.vite/manifest.json` exactly once, at boot, and NEVER falls back: each way
   * that read can fail is its own named error (`./hydration-client-url.ts:24`,
   * `:36`, `:53`), because "serve without hydration" would be a page that
   * renders and then does nothing.
   *
   * `webRoot` is OPTIONAL because only the dev branch has any use for it, and
   * asking production for it would be worse than useless: it is proved by
   * reading `<root>/package.json` off disk, which is exactly the kind of
   * source-tree lookup a built artifact must never depend on. A dev boot that
   * somehow reaches here without one is refused by name by the entry factory.
   */
  protected resolveHydrationClientModuleUrl(webRoot?: string): string {
    if (isProductionRuntime()) {
      return resolveHydrationClientUrl({ clientDir: this.resolveClientDir() });
    }

    return createHydrationClientEntry(webRoot ?? "").devUrl;
  }

  /**
   * `<outdir>/client` — the layout the build half writes and this half reads
   * at boot, taken from the value the build BAKED into the page manifest.
   *
   * It used to call `resolveBuildConfig()`, which reads `warlock.config.ts`
   * through `warlockConfigManager`. That works in `warlock build` and in the
   * `warlock start` SUPERVISOR, and it cannot work here: the supervisor spawns
   * a plain `node dist/app.js` CHILD, and that process never loads — and could
   * not load — a TypeScript build-time config. The call threw
   * `WarlockConfig not loaded` inside connector boot, so the production server
   * died before it ever listened.
   *
   * Baking it also settles the drift the old comment was worried about, and
   * settles it harder: `build` and `start` cannot disagree about where the
   * bundle lives, because `start` is no longer re-deriving the path at all —
   * it reads back the one string `build` wrote.
   */
  protected resolveClientDir(): string {
    // The manifest CACHED at boot (line ~269), not a second `consumePageManifest()`:
    // this runs from a callback the production branch invokes lazily, long after
    // that assignment, and reading the same field the mode branch already
    // decided on keeps one source of truth for the boot's view of the manifest.
    const clientDir = this.pageManifest?.clientDir;

    if (clientDir === undefined) {
      // Reached only via a manifest with browser artifacts but no `clientDir`
      // — i.e. a bundle built by a web version older than this field. Named here
      // rather than left to surface as an ENOENT on a `path.join(undefined)`
      // deep inside the manifest read.
      throw new WebClientDirMissingError();
    }

    return path.resolve(process.cwd(), clientDir);
  }

  /**
   * The page manifest this connector consumed at boot, or `undefined` in dev
   * where Vite supplies the modules instead.
   */
  public getPageManifest(): PageManifest | undefined {
    return this.pageManifest;
  }

  /**
   * Activate. There is nothing to listen on — `HttpConnector.start()` owns the
   * single `listen()` for the whole process — so this only marks the connector
   * live once `boot()` has wired everything.
   */
  public async start(): Promise<void> {
    if (!this.vite) return;

    this.active = true;
  }

  /**
   * Shutdown — close Vite, and drop the sockets Vite's middleware left behind.
   *
   * Reverse-priority teardown (`core/src/connectors/connectors-manager.ts:118`)
   * puts this BEFORE `HttpConnector.shutdown()`, which is exactly what the
   * second call needs: requests answered by Vite's connect stack are written
   * straight to `reply.raw`, so Fastify never observes them completing and their
   * keep-alive sockets are never counted idle. Core's default
   * `forceCloseConnections: "idle"` (`core/src/http/server.ts:34`) then waits on
   * them forever. A dev server has no draining obligation, and the connector
   * that caused the raw writes is the right one to clean up after them.
   */
  public async shutdown(): Promise<void> {
    if (!this.active) return;

    if (container.has("http.server")) {
      container.get("http.server").server.closeAllConnections();
    }

    await this.vite?.close();
    this.vite = undefined;
    this.installedPages = [];
    this.installDevPageRoutes = undefined;
    this.pendingPageChanges = undefined;
    this.pendingHotUpdateSuppressions.clear();
    this.pageManifest = undefined;

    this.active = false;
  }

  /**
   * Queue page add/remove/edit candidates for asynchronous live routing work.
   * Classification stays synchronous because core's connector interface is;
   * edited route exports are evaluated later through Vite's fresh SSR graph.
   */
  public shouldRestart(changedFiles: string[] = []): boolean {
    if (this.vite === undefined || this.resolvedPaths === undefined) {
      return false;
    }

    this.pendingPageChanges = this.classifyPageChanges(changedFiles);
    return this.pendingPageChanges !== undefined;
  }

  protected classifyPageChanges(changedFiles: readonly string[]): PageFileChanges | undefined {
    if (this.resolvedPaths === undefined) return undefined;

    const changes = classifyPageFileChanges(changedFiles, {
      appRoot: this.resolvedPaths.appRoot,
      appSrcRoot: this.resolvedPaths.appSrcRoot,
      installedPageFiles: registeredPageFiles(router.list(), this.resolvedPaths.appSrcRoot),
    });

    return hasPageFileChanges(changes) ? changes : undefined;
  }

  protected enqueuePageRouteReload(changes: PageFileChanges): Promise<boolean> {
    const eventVersions = pageChangeVersions(changes);
    const run = this.pageRouteReloadQueue
      .catch(() => undefined)
      .then(async () => {
        const vite = this.vite;
        const install = this.installDevPageRoutes;
        const paths = this.resolvedPaths;

        if (vite === undefined || install === undefined || paths === undefined) return false;

        const matchingCommittedFiles = new Set<string>();

        // This check belongs inside the queue: a matching core transaction may
        // commit while a Vite callback is waiting behind it. File versions are
        // captured when the job is queued so a later edit cannot consume an
        // earlier event's marker.
        for (const [file, eventVersion] of eventVersions) {
          const committedVersion = this.pendingHotUpdateSuppressions.get(file);
          if (committedVersion === undefined) continue;

          // Matching markers are consumed exactly once. A mismatched marker is
          // obsolete and must not survive to suppress a future reverted edit.
          this.pendingHotUpdateSuppressions.delete(file);
          if (committedVersion === eventVersion) matchingCommittedFiles.add(file);
        }

        if (eventVersions.size > 0 && matchingCommittedFiles.size === eventVersions.size) {
          return true;
        }

        const replace = await pageRoutesNeedReplacement(changes, {
          vite,
          appSrcRoot: paths.appSrcRoot,
          installedPages: this.installedPages,
        });

        if (!replace) return false;

        const nextInstalledPages = await router.replaceRoutesBySourceFiles(
          pageRouteSourceFiles(router.list()),
          install,
        );

        // Advance observable state only after the router transaction commits.
        // A rejected install keeps both the old route table and browser live.
        this.installedPages = nextInstalledPages;
        invalidateClientPageRegistry(vite);

        for (const [file, eventVersion] of eventVersions) {
          if (!matchingCommittedFiles.has(file)) {
            this.pendingHotUpdateSuppressions.set(file, eventVersion);
          }
        }

        return true;
      });

    this.pageRouteReloadQueue = run;
    return run;
  }

  /**
   * Vite-side ordering barrier. It publishes a changed route graph before the
   * page-registry plugin can reload the document; a matching change already
   * handled by core is consumed once, preventing a duplicate full reload.
   */
  protected async handlePageHotUpdate(file: string): Promise<boolean> {
    const absoluteFile = path.resolve(file);
    const changes = this.classifyPageChanges([absoluteFile]);
    if (changes === undefined) return false;

    return this.enqueuePageRouteReload(changes);
  }

  /**
   * Live page routing update. Despite the connector API name, this never closes
   * Vite: it atomically replaces page-owned routes only when membership or the
   * canonical route identity changed, then refreshes the client registry.
   */
  public async restart(): Promise<void> {
    const changes = this.pendingPageChanges;
    this.pendingPageChanges = undefined;

    if (
      changes === undefined ||
      this.resolvedPaths === undefined ||
      this.vite === undefined ||
      this.installDevPageRoutes === undefined
    ) {
      return;
    }

    await this.enqueuePageRouteReload(changes);
  }

  /** The pages this connector registered on the router, in registration order. */
  public getInstalledPages(): readonly InstalledPageRoute[] {
    return this.installedPages;
  }

  /**
   * The Fastify instance the HTTP connector published during its own `boot()`
   * (`core/src/connectors/http-connector.ts:74`).
   *
   * Absence is fatal rather than a silent no-op: unlike sockets, there is no
   * standalone fallback a page surface could serve from, and the failure this
   * guards against — an app with no `src/config/http.ts` — otherwise shows up
   * as every page 404ing with no explanation.
   */
  protected resolveFastify(): FastifyInstance {
    if (!container.has("http.server")) {
      throw new Error(
        "WebConnector requires the HTTP connector's Fastify instance, but " +
          "`http.server` is not in the container. The `http` config is missing — add `src/config/http.ts` " +
          "so `HttpConnector.boot()` runs (core/src/connectors/http-connector.ts:61-74).",
      );
    }

    return container.get("http.server");
  }

  /** Resolve every path this connector needs from the (optional) options. */
  protected async resolvePaths() {
    const appRoot = this.options.appRoot ?? process.cwd();
    const appSrcRoot = this.options.appSrcRoot ?? path.join(appRoot, "src");
    const selfPath = fileURLToPath(import.meta.url);
    // The web package root goes through `resolveWebPackageRoot`, which PROVES
    // the directory by reading `<root>/package.json` and matching its `name`,
    // rather than trusting a fixed number of `..` hops. A configured root is
    // asserted the same way. Either failure throws
    // `WebPackageRootResolutionError` naming the directory at boot — the
    // alternative was a wrong root surfacing much later as a 404 on the
    // hydration entry with nothing to point at.
    const webRoot = await resolveWebPackageRoot(this.options.webRoot);

    return {
      appRoot,
      appSrcRoot,
      appFile: this.options.appFile ?? path.join(appSrcRoot, "web/root.tsx"),
      webRoot,
      // Extension-agnostic on purpose: the sibling barrel is `index.ts` when
      // this package runs from source and `index.js` once it is built, the same
      // trick `registerLoader` uses when it resolves its own siblings.
      webServerBarrel: path.join(path.dirname(selfPath), `index${path.extname(selfPath)}`),
    };
  }

  protected async createViteServer(
    fastify: FastifyInstance,
    paths: Awaited<ReturnType<WebConnector["resolvePaths"]>>,
  ): Promise<ViteDevServer> {
    const { createServer, buildErrorMessage, searchForWorkspaceRoot } = await import("vite");

    // Vite's own default for `server.fs.allow`, reproduced rather than dropped:
    // naming the key at all REPLACES the default, and an application that
    // legitimately serves files from above its own root has to keep working.
    const workspaceRoot = searchForWorkspaceRoot(paths.appRoot);

    return createServer(
      await createWebConnectorViteConfig({
        appRoot: paths.appRoot,
        appSrcRoot: paths.appSrcRoot,
        webRoot: paths.webRoot,
        workspaceRoot,
        hmrServer: fastify.server,
        handlePageHotUpdate: (file) => this.handlePageHotUpdate(file),
        leadingPlugins: [devErrorTransportPlugin({ isProductionRuntime, buildErrorMessage })],
        resolveAlias: this.options.resolveAlias,
        ssrExternal: this.options.ssrExternal,
        plugins: this.options.plugins,
      }),
    );
  }
}
