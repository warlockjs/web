/**
 * `WebConnector` — the SSR page surface as a first-class Warlock connector.
 *
 * It runs BESIDE `HttpConnector`, never instead of it: `warlock dev` alone now boots the API *and* serves React
 * pages on one port, and `web` no longer owns a private copy of the HTTP
 * lifecycle. Everything this file does used to live in `startDevServer()`
 * (`web/src/server/dev-server.ts`), which created its own Fastify instance,
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
 * `./dev-server.ts` and `./install-page-routes.ts` record in their own headers:
 * this module is not re-exported from any package barrel (`web/src/index.ts`,
 * `web/src/server/index.ts`, `web/src/connector/index.ts`) and is not part of
 * `web/package.json`'s dependency graph. It is dev/CLI bootstrap code, only
 * ever imported by tooling that already depends on core.
 *
 * `@warlock.js/web/connector` reaches this class ONLY through
 * `./web-connector-factory.ts`'s `await import("./web-connector")` — a
 * deliberate seam, because a static edge from that barrel to this file would
 * put `../vite`, core's router and `./dev-server` into the import graph of
 * every consuming app's `warlock.config.ts`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";
import type { Alias, Plugin, PluginOption, ViteDevServer } from "vite";
import { Application, BaseConnector, ConnectorLifecyclePhase, type ConnectorName, container, type FastifyInstance, requestContext, router } from "@warlock.js/core";
import { resolveWebPackageRoot } from "../build/contribution";
import { appConventionAliases } from "../vite/app-convention-aliases";
import {
  createHydrationClientEntry,
  invalidateClientPageRegistry,
  warlockClientBoundary,
} from "../vite";
import { CLIENT_ASSET_URL_PREFIX } from "./client-asset-url-prefix";
import { devErrorTransportPlugin, sendCapturedDevError } from "./dev-server";
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
 * Third-party packages core reaches through `await import(...)` and that must
 * therefore never enter Vite's SSR transform graph.
 *
 * Left un-externalized, Vite's SSR module runner tries to resolve them anyway
 * and jams: the failure is NOT a missing-module error but a `transport invoke
 * timed out` on whatever unrelated module happened to be in flight. Derived in
 * one pass from `peerDependenciesMeta.optional` across every workspace package
 * reachable from `core/src/index.ts`, and carried over verbatim from
 * `dev-server.ts`'s own list. Only THIRD-PARTY peers belong here — every
 * `@warlock.js/*` sibling must stay in Vite's graph.
 *
 * This list is core's peer list, not web's; publishing it from core instead
 * of duplicating it here is still outstanding.
 */
const CORE_OPTIONAL_PEERS = [
  // mail
  "nodemailer",
  "@aws-sdk/client-sesv2",
  "@react-email/render",
  // cache
  "redis",
  "pg",
  // cascade
  "mongodb",
  // logger
  "@sentry/node",
  // core
  "sharp",
  "socket.io",
  "@aws-sdk/client-s3",
  "@aws-sdk/lib-storage",
  "@aws-sdk/s3-request-presigner",
  // herald
  "amqplib",
  // ai
  "langfuse",
  "openai",
  "pdf-parse",
] as const;

/**
 * `web`'s OWN optional peers, kept separate from {@link CORE_OPTIONAL_PEERS}
 * because that list is core's and is documented as such.
 *
 * Same rule, same reason: anything this package reaches through
 * `await import(...)` must be external to every bundler and SSR pipeline, or
 * some pipeline will try to resolve it in an install that legitimately does not
 * have it. `vite` itself is the precedent — `createViteServer` has always
 * loaded it this way — and `@vitejs/plugin-react` is loaded from the same
 * function, for the same dev-only reason, so it belongs in the same set.
 */
const WEB_OPTIONAL_PEERS = ["vite", "@vitejs/plugin-react"] as const;

/**
 * Public specifier for the React Fast Refresh preamble module this connector
 * injects. See {@link WebConnector.resolveReactFastRefreshPlugins}.
 */
const REACT_REFRESH_PREAMBLE_ID = "virtual:warlock/react-refresh-preamble";

/** The `\0`-prefixed form Rollup uses to mark a module as not-a-file. */
const RESOLVED_REACT_REFRESH_PREAMBLE_ID = `\0${REACT_REFRESH_PREAMBLE_ID}`;

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

/** `@vitejs/plugin-react`'s default export, plus the one static it publishes. */
type ReactPluginFactory = ((options?: Record<string, unknown>) => PluginOption[]) & {
  preambleCode?: string;
};

/**
 * A directory, plus the path the filesystem really stores it at when the two
 * differ. Both forms belong in `server.fs.allow` — see the `fs` block in
 * {@link WebConnector.createViteServer} for why one of them is never enough.
 *
 * A missing directory is not this function's problem to report: the roots it is
 * handed are already proven (`resolveWebPackageRoot`) or are the app's own cwd,
 * and an allow-list entry that points nowhere simply matches nothing.
 */
function withRealPath(directory: string): string[] {
  try {
    const realPath = fs.realpathSync(directory);

    return realPath === directory ? [directory] : [directory, realPath];
  } catch {
    return [directory];
  }
}

/** POSIX-normalised, case-folded — Vite ids are `/`-separated on Windows too. */
function normalizeModuleId(id: string): string {
  const [filepath] = id.split("?");

  return filepath.replace(/\\/g, "/").toLowerCase();
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
      if ((this.pageManifest.publicFiles?.length ?? 0) > 0) {
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

    this.installDevPageRoutes = () => webServerSsr.installPageRoutes({
      router,
      vite: this.vite,
      appSrcRoot: paths.appSrcRoot,
      appFile: paths.appFile,
      hydrationClientModuleUrl: this.resolveHydrationClientModuleUrl(paths.webRoot),
      // Without these the first paint of every full page load is unstyled: the
      // client bundle imports the CSS, so JavaScript applies it only after the
      // module graph loads. A render-blocking <link> in <head> is what makes
      // the page arrive styled instead of arriving and then correcting itself.
      stylesheetUrls: webServerSsr.devStylesheetUrls(paths.appRoot, paths.appFile),
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
    const run = this.pageRouteReloadQueue.catch(() => undefined).then(async () => {
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
          '`http.server` is not in the container. The `http` config is missing — add `src/config/http.ts` ' +
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

  /**
   * Vite in middleware mode, `appType: "custom"` — Warlock owns the response
   * shape and Vite never fronts the server.
   *
   * `server.hmr.server` is handed the RAW node server (`fastify.server`), so the
   * HMR websocket shares the one port the app already listens on. No `hmr.port`
   * and no `clientPort`: Vite's HMR path stays the default `"/"`, socket.io
   * stays on `"/socket.io"` (`core/src/connectors/socket-connector.ts:90`), and
   * the two `upgrade` listeners coexist because each is a selective filter that
   * leaves a non-matching socket alone — verified empirically in both attachment
   * orders.
   */
  /**
   * React Fast Refresh, or nothing at all — never half of it.
   *
   * TWO plugins, and the second one is not optional. `@vitejs/plugin-react`
   * emits, into every client component module, a wrapper that reads
   * `window.$RefreshReg$` and THROWS "can't detect preamble" if it is missing.
   * The preamble that defines it normally arrives through Vite's
   * `transformIndexHtml`, and this pipeline has no HTML for Vite to transform:
   * the document is React's SSR output and the only script appended to it is
   * the hydration entry (`./create-page-route-handler.ts:95`). So the preamble
   * is delivered as a virtual module that the hydration entry imports FIRST.
   *
   * "First" is load-bearing, twice over. ESM evaluates a module's imports in
   * source order before the importer's own body, so an import placed at
   * position 0 runs before `virtual:warlock/pages` pulls in a single component
   * — which is what `$RefreshReg$` has to exist for — and before `react-dom`
   * initialises, which is what `injectIntoGlobalHook` has to precede.
   *
   * The preamble TEXT is read from the plugin's own `preambleCode` export
   * rather than copied here, so a version bump cannot leave this file holding
   * a stale runtime contract. If that export ever stops being a string, Fast
   * Refresh is DECLINED entirely (empty array) instead of registered without
   * its preamble — a loud "no HMR" beats a component graph that throws on
   * first paint.
   *
   * Dev-only by construction, like everything else this method is called from:
   * `apply: "serve"` on our own plugin, `apply: "serve"` on the plugin's
   * refresh half, and `skipFastRefresh` on `config.isProduction` inside it. The
   * PRODUCTION client bundle cannot reach any of this — it is built by
   * `buildWarlockHydrationClient` (`../vite/index.ts:185`), which composes
   * `warlockClientBoundary()` and nothing else, and never calls this method.
   *
   * @param paths resolved by {@link WebConnector.resolvePaths}
   */
  protected async resolveReactFastRefreshPlugins(
    paths: Awaited<ReturnType<WebConnector["resolvePaths"]>>,
  ): Promise<PluginOption[]> {
    let viteReact: ReactPluginFactory;

    try {
      // OPTIONAL peer (`web/package.json`'s `peerDependenciesMeta`), so this is
      // a lazy `await import` exactly like the `vite` one above it, and
      // `@vitejs/plugin-react` is listed in `WEB_OPTIONAL_PEERS` for the same
      // reason `vite` is.
      ({ default: viteReact } = (await import("@vitejs/plugin-react")) as unknown as {
        default: ReactPluginFactory;
      });
    } catch {
      console.warn(
        "[warlock:web] React Fast Refresh is OFF: `@vitejs/plugin-react` is not installed. " +
          "Edits to a component will reload the page instead of hot-swapping it. " +
          "Install it with `npm i -D @vitejs/plugin-react` to enable it.",
      );

      return [];
    }

    const preambleCode = viteReact.preambleCode;

    if (typeof preambleCode !== "string") {
      console.warn(
        "[warlock:web] React Fast Refresh is OFF: this `@vitejs/plugin-react` no longer exports " +
          "`preambleCode`, so the refresh preamble cannot be injected into the hydration entry. " +
          "Registering the plugin without it would make every component module throw " +
          "\"can't detect preamble\" in the browser.",
      );

      return [];
    }

    // `base` is never set on the config below, so it is Vite's default `"/"`.
    const preambleSource = preambleCode.replace("__BASE__", "/");
    const hydrationEntryId = normalizeModuleId(createHydrationClientEntry(paths.webRoot).sourcePath);

    const preamblePlugin: Plugin = {
      name: "warlock:react-refresh-preamble",
      // BEFORE `warlock:projection` and the gates would be wrong and BEFORE
      // esbuild's TS transform is required: this prepends one import statement
      // to TypeScript source, so it has to see the file before anything lowers
      // it. It touches exactly one module, so it cannot reorder anything else.
      enforce: "pre",
      apply: "serve",
      // The preamble is browser state (`window.$RefreshReg$`). The SSR
      // environment must never evaluate it — there is no `window` there, and
      // the server render must stay byte-identical to what it produced before
      // this plugin existed.
      applyToEnvironment: environment => environment.config.consumer === "client",
      resolveId(source) {
        if (source === REACT_REFRESH_PREAMBLE_ID) return RESOLVED_REACT_REFRESH_PREAMBLE_ID;

        return null;
      },
      load(id) {
        if (id === RESOLVED_REACT_REFRESH_PREAMBLE_ID) return preambleSource;

        return null;
      },
      transform(code, id) {
        if (normalizeModuleId(id) !== hydrationEntryId) return null;

        return { code: `import ${JSON.stringify(REACT_REFRESH_PREAMBLE_ID)};\n${code}`, map: null };
      },
    };

    return [preamblePlugin, ...viteReact()];
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

    return createServer({
      root: paths.appRoot,
      appType: "custom",
      plugins: [
        // FIRST, and dev-only by construction: this method is reachable only
        // from `boot()`'s Vite branch, past the `isProductionRuntime()` guard.
        // The same predicate is handed in rather than re-derived, and the
        // factory throws if it is ever true — see the plugin's own header for
        // why the layer has to be registered from a plugin and not from
        // `vite.middlewares.use(...)` after this call returns.
        devErrorTransportPlugin({ isProductionRuntime, buildErrorMessage }),
        ...warlockClientBoundary({
          appRoot: paths.appRoot,
          beforePageHotUpdate: ({ file }) => this.handlePageHotUpdate(file),
        }),
        // AFTER the boundary, and the order matters among `enforce: "pre"`
        // plugins (Vite keeps array order within an enforce bucket).
        // `warlock:projection` strips a page's server exports — `loader` and
        // friends — before React's babel pass sees the module, so Fast Refresh
        // never registers a refresh boundary for an export that is not supposed
        // to reach the browser at all.
        //
        // BEFORE `options.plugins` so an application can still override.
        ...(await this.resolveReactFastRefreshPlugins(paths)),
        ...(this.options.plugins ?? []),
      ],
      server: {
        middlewareMode: true,
        hmr: { server: fastify.server },
        fs: {
          // `<Scripts />` points the browser at the hydration client entry under
          // `<webRoot>`: the published `esm/hydration/index.mjs` when installed,
          // or `src/hydration/index.ts` in this checkout. A dependency normally
          // lives under the app root's `node_modules`; when `@warlock.js/web` is
          // LINKED — a monorepo checkout, `npm link`, or a `file:` dependency —
          // its real path can sit outside every directory Vite allows by default
          // and the request comes back `403 Restricted`.
          //
          // That failure is silent in the worst way: SSR has already produced
          // the markup by the time the browser asks for the script, so the page
          // renders perfectly, nothing is logged, and the only symptom is that
          // no button ever works. Naming web's own root makes a linked install
          // behave like an installed one.
          //
          // Every root is listed twice, as given and as `realpathSync` reports
          // it, because Vite resolves a requested file to its REAL path before
          // testing it against this list. Allowing the symlink alone therefore
          // matches nothing — the 403 page prints the link that was allowed
          // directly above the real path it rejected.
          allow: [
            ...new Set([
              ...withRealPath(workspaceRoot),
              ...withRealPath(paths.appRoot),
              ...withRealPath(paths.webRoot),
            ]),
          ],
        },
      },
      // Without an explicit target, esbuild assumes native (TC39) decorator
      // support and leaves `@RegisterModel()`-style syntax untouched — but Vite's
      // SSR module runner evaluates transformed code via `new AsyncFunction(...)`,
      // which node has no native decorator support for. `es2022` downlevels them
      // into helper calls. `jsx` is named explicitly rather than left to tsconfig
      // discovery, because Vite matches a file against a tsconfig's `include` and
      // `web/tsconfig.json`'s is narrow enough that most of `web/src` matched no
      // config at all and fell back to the CLASSIC transform — emitting
      // `React.createElement` into modules that import no `React` binding.
      esbuild: { target: "es2022", jsx: "automatic" },
      /**
       * REACT MUST BE PRE-BUNDLED, and naming it here is the only thing that
       * makes that happen for the framework's own client graph.
       *
       * `react-dom/client` is CommonJS. A browser cannot import a named export
       * from it, so Vite's dep optimizer normally rewrites it into an ESM shim
       * under `/node_modules/.vite/deps/`. Whether that rewrite happens is
       * decided in `tryNodeResolve`, and one of the conditions that SKIPS it is
       * `importer && isInNodeModules(importer)`
       * (`vite/dist/node/chunks/config.js:32822`). Vite's reasoning is sound in
       * general — a dependency's own internal imports are the optimizer's job,
       * not the resolver's — but it is exactly wrong here:
       *
       *   `<Scripts />` points the browser at the hydration entry, and in an
       *   INSTALLED app that entry is
       *   `<app>/node_modules/@warlock.js/web/esm/hydration/index.mjs`.
       *   Every module it reaches is therefore inside `node_modules`, so every
       *   bare import it makes takes the skip branch and is served as the raw
       *   file with a `?v=<browserHash>` cache key bolted on.
       *
       * For `esm/**.mjs` that is harmless — they are already ESM. For
       * `react-dom/client` it is fatal, and it is the whole defect: the browser
       * receives `"use strict"; function checkDCE()…` and refuses the module
       * with
       *
       *     SyntaxError: The requested module '/node_modules/react-dom/client.js?v=…'
       *     does not provide an export named 'hydrateRoot'
       *
       * Nothing in the client runtime then runs at all: no hydration, so no
       * `useState`, no Fast Refresh, and `<Link>` degrades to a full document
       * load because the navigation listener was never attached. Measured on a
       * published 5.0.2 install (fresh app, no symlinks): all four symptoms
       * before this block, none after.
       *
       * `include` is the fix rather than `entries` because it does not depend
       * on the scanner reaching the entry: an included id is pre-bundled at
       * server start and `tryOptimizedResolve` matches it by NAME
       * (`config.js:32633`) before `tryNodeResolve` — and that lookup has no
       * importer condition, so a node_modules importer resolves to the shim
       * like anyone else. Pointing `optimizeDeps.entries` at the hydration
       * entry would not work: the scanner classifies a resolution inside
       * `node_modules` as a dependency to externalize rather than a source to
       * walk.
       *
       * All four names are listed even though `react` and `react/jsx-runtime`
       * usually get discovered anyway — they are discovered only because the
       * APP's own pages import them, which is a fact about the app and not
       * something the framework may rely on. `react-dom/client` is imported by
       * `client/hydrate-page.tsx` and by nothing a normal app writes, which is
       * why it was the one that broke.
       *
       * This is INVISIBLE from the monorepo checkout: there the hydration entry
       * resolves to `web/src/hydration/index.ts`, a path with no `node_modules`
       * segment, so the skip branch never fires and React optimizes normally.
       * Canon: nothing measured inside the checkout is evidence about a
       * published install.
       */
      optimizeDeps: {
        include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
        /**
         * The SECOND instance problem, and the reason this is `exclude` and not
         * another `include`.
         *
         * An app page's `import { Link } from "@warlock.js/web"` has an importer
         * OUTSIDE `node_modules`, so it takes the opposite branch above and the
         * whole package is pre-bundled into
         * `/node_modules/.vite/deps/@warlock__js_web.js`. The hydration entry
         * cannot reach that bundle — it is loaded by absolute path through
         * `/@fs/` and its imports are relative, so they resolve to the raw
         * `esm/*.mjs` files. The browser then holds TWO copies of every client
         * module in this package: the app renders `<Link>` from the bundled one
         * while the hydration entry publishes routes and mounts the document
         * context on the raw one. Module-level state does not cross that line.
         *
         * `routing/route-table` survives it by accident — it keeps its table in
         * a `Symbol.for` slot on `globalThis`, which is realm-wide — but
         * `components/document-context` is a React context OBJECT, and two
         * `createContext()` calls are two different contexts no provider can
         * bridge.
         *
         * Excluding the package makes the app's import resolve to
         * `esm/index.mjs` with the same `?v=` key the hydration entry's imports
         * carry, so there is one instance again. It costs the pre-bundle (a
         * handful of extra dev requests for files that are already valid ESM)
         * and nothing else — the grep across every client-reachable module in
         * this package finds exactly three bare imports, all of them React, all
         * of them covered by `include` above.
         */
        exclude: ["@warlock.js/web"],
      },
      ssr: {
        external: [
          ...CORE_OPTIONAL_PEERS,
          ...WEB_OPTIONAL_PEERS,
          ...(this.options.ssrExternal ?? []),
        ],
        /**
         * ONE `@warlock.js/web`, for the same reason `resolve.dedupe` below
         * insists on one React — and it is invisible from inside this repo.
         *
         * Vite externalises `node_modules` in SSR by default, so an installed
         * app gets TWO instances: the app's own `root.tsx` imports
         * `@warlock.js/web` and Vite hands that off to Node, while the pipeline
         * is loaded deliberately through `vite.ssrLoadModule(...)` and stays
         * inside Vite's graph. `renderPage` then sets the document context on
         * Vite's copy of `components/document-context`, and the app's `<Head/>`
         * reads Node's copy, which has nothing in it:
         *
         *     <Head/> was rendered outside the page pipeline's document context
         *
         * Measured on a published 5.0.1 install: `GET /` 500 without this line,
         * 200 with it (404 control still 404). In THIS checkout the package
         * resolves to source under Vite's root, never through `node_modules`,
         * so both paths land on one instance and the bug cannot reproduce.
         * Canon `6b7ab838`.
         */
        noExternal: ["@warlock.js/web"],
      },
      resolve: {
        // ONE React, resolved from the application. A linked `@warlock.js/web`
        // resolves `react` out of its own tree while the app's pages resolve it
        // out of theirs; two React instances share no hook dispatcher, and SSR
        // dies on the first `useState` with "Cannot read properties of null".
        // `dedupe` forces these package names to resolve from Vite's `root` —
        // the app — whoever imported them, in the SSR environment as much as in
        // the client one.
        //
        // Two names cover every entry point. Vite matches a deep import against
        // the package it belongs to before consulting this list, so
        // `react-dom/client`, `react/jsx-runtime` and `react/jsx-dev-runtime`
        // are already deduped by `react-dom` and `react`; listing them
        // separately would only add entries that can never match.
        //
        // Do NOT express this as a `resolve.alias` entry instead. Pointing a
        // bare React specifier at a directory drags React's CommonJS entry into
        // Vite's SSR module graph, and the dev server then dies at startup with
        // "module is not defined" before it renders anything at all.
        dedupe: ["react", "react-dom"],
        alias: [
          ...(this.options.resolveAlias ?? []),
          // The app-tree convention `v5/app/tsconfig.json`'s own `paths` declare.
          // Vite does not read tsconfig paths on its own and no
          // `vite-tsconfig-paths` plugin is installed in this workspace.
          //
          // ONE definition, shared with the production build contribution
          // (`web/src/build/contribution.ts`). These were two separate literals
          // until 2026-08-24, and the production half simply did not have them —
          // dev resolved `web/*` while the production client build died on the
          // first page. Do not inline them back here.
          ...appConventionAliases(paths.appSrcRoot),
        ],
      },
    });
  }
}
