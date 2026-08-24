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
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";
import type { Alias, PluginOption, ViteDevServer } from "vite";
import { Application } from "../../../core/src/application/application";
import { BaseConnector } from "../../../core/src/connectors/base-connector";
import {
  ConnectorLifecyclePhase,
  type ConnectorName,
} from "../../../core/src/connectors/types";
import { container } from "../../../core/src/container";
import { requestContext } from "../../../core/src/http/context/request-context";
import type { FastifyInstance } from "../../../core/src/http/server";
import { router } from "../../../core/src/router/router";
import { resolveWebPackageRoot } from "../build/contribution";
import { appConventionAliases } from "../vite/app-convention-aliases";
import { createHydrationClientEntry, warlockClientBoundary } from "../vite";
import { CLIENT_ASSET_URL_PREFIX } from "./client-asset-url-prefix";
import { applyBufferedCookie, devErrorTransportPlugin, sendCapturedDevError } from "./dev-server";
import { resolveHydrationClientUrl } from "./hydration-client-url";
import type { InstalledPageRoute } from "./install-page-routes";
import { installProductionPageRoutes } from "./install-production-page-routes";
import { consumePageManifest, type PageManifest } from "./page-manifest";
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
 * The manifest carried pages but no `clientDir`.
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
      "The page manifest carries pages but no `clientDir`, so the connector cannot " +
        "locate the client bundle. This artifact was built by an older @warlock.js/web " +
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
   * Nothing. Page, layout and component edits are Vite's HMR to own — a
   * connector restart would tear down the module graph Vite is keeping warm.
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
      this.installedPages = await installProductionPageRoutes({
        router,
        manifest: this.pageManifest,
        pageContext: requestContext,
        sharedStore: () => requestContext.getStore(),
        applyBufferedCookie,
        // The URL is resolved lazily, by the production path, only if there are
        // pages to hydrate — see the option's own note.
        resolveHydrationClientModuleUrl: () => this.resolveHydrationClientModuleUrl(),
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
      // Gated on the page count for the same reason the build's `emit` hook is:
      // a zero-page build produces NO client bundle, so there is no directory
      // to mount and no `clientDir` baked into the manifest to name one. The
      // two halves skip on the same condition, so neither can expect an
      // artifact the other did not make.
      if (this.pageManifest.pages.length > 0) {
        router.directory({
          root: path.join(this.resolveClientDir(), "assets"),
          prefix: `${CLIENT_ASSET_URL_PREFIX}/`,
        });
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

    this.installedPages = await webServerSsr.installPageRoutes({
      router,
      vite: this.vite,
      appSrcRoot: paths.appSrcRoot,
      appFile: paths.appFile,
      hydrationClientModuleUrl: this.resolveHydrationClientModuleUrl(paths.webRoot),
      applyBufferedCookie,
    });
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
      // Reached only via a manifest with pages but no `clientDir` — i.e. a
      // bundle built by a web version older than this field. Named here
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
    this.pageManifest = undefined;

    this.active = false;
  }

  /**
   * Never restart on a file change. Pages, layouts and components are Vite's
   * HMR domain; rebooting this connector would drop Vite's module graph and
   * re-register every page route on a Fastify instance that is already serving.
   */
  public shouldRestart(): boolean {
    return false;
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
  protected async createViteServer(
    fastify: FastifyInstance,
    paths: Awaited<ReturnType<WebConnector["resolvePaths"]>>,
  ): Promise<ViteDevServer> {
    const { createServer, buildErrorMessage } = await import("vite");

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
        ...warlockClientBoundary({ appRoot: paths.appRoot }),
        ...(this.options.plugins ?? []),
      ],
      server: {
        middlewareMode: true,
        hmr: { server: fastify.server },
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
      ssr: {
        external: [...CORE_OPTIONAL_PEERS, ...(this.options.ssrExternal ?? [])],
      },
      resolve: {
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
