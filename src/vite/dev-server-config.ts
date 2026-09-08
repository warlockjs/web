import fs from "node:fs";
import type { Alias, HttpServer, InlineConfig, PluginOption } from "vite";
import { appConventionAliases } from "./app-convention-aliases";
import { warlockClientBoundary } from "./index";
import { resolveReactFastRefreshPlugins } from "./react-refresh-preamble";

/**
 * Third-party packages core reaches through `await import(...)` and that must
 * therefore never enter Vite's SSR transform graph.
 *
 * Left un-externalized, Vite's SSR module runner tries to resolve them anyway
 * and jams: the failure is NOT a missing-module error but a `transport invoke
 * timed out` on whatever unrelated module happened to be in flight. Derived in
 * one pass from `peerDependenciesMeta.optional` across every workspace package
 * reachable from `core/src/index.ts`, and carried over verbatim from
 * `dev-error-transport.ts`'s own list. Only THIRD-PARTY peers belong here — every
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
 * A directory, plus the path the filesystem really stores it at when the two
 * differ. Both forms belong in `server.fs.allow` — see the `fs` block in
 * {@link createWebConnectorViteConfig} for why one of them is never enough.
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

export type WebConnectorViteConfigOptions = {
  appRoot: string;
  appSrcRoot: string;
  webRoot: string;
  workspaceRoot: string;
  /** The raw node server Vite's HMR websocket shares with the rest of the app. */
  hmrServer: HttpServer;
  handlePageHotUpdate: (file: string) => Promise<boolean>;
  /** Plugins that must run ahead of the client-boundary gates, e.g. `devErrorTransportPlugin`. */
  leadingPlugins: PluginOption[];
  resolveAlias?: Alias[];
  ssrExternal?: string[];
  plugins?: PluginOption[];
};

/**
 * `WebConnector`'s Vite dev-server config — Vite in middleware mode,
 * `appType: "custom"` — Warlock owns the response shape and Vite never fronts
 * the server.
 *
 * `server.hmr.server` is handed the RAW node server (`fastify.server`), so the
 * HMR websocket shares the one port the app already listens on. No `hmr.port`
 * and no `clientPort`: Vite's HMR path stays the default `"/"`, socket.io
 * stays on `"/socket.io"` (`core/src/connectors/socket-connector.ts:90`), and
 * the two `upgrade` listeners coexist because each is a selective filter that
 * leaves a non-matching socket alone — verified empirically in both attachment
 * orders.
 */
export async function createWebConnectorViteConfig(
  options: WebConnectorViteConfigOptions,
): Promise<InlineConfig> {
  return {
    root: options.appRoot,
    appType: "custom",
    plugins: [
      // FIRST, and dev-only by construction: this method is reachable only
      // from `boot()`'s Vite branch, past the `isProductionRuntime()` guard.
      // The same predicate is handed in rather than re-derived, and the
      // factory throws if it is ever true — see the plugin's own header for
      // why the layer has to be registered from a plugin and not from
      // `vite.middlewares.use(...)` after this call returns.
      ...options.leadingPlugins,
      ...warlockClientBoundary({
        appRoot: options.appRoot,
        beforePageHotUpdate: ({ file }) => options.handlePageHotUpdate(file),
      }),
      // AFTER the boundary, and the order matters among `enforce: "pre"`
      // plugins (Vite keeps array order within an enforce bucket).
      // `warlock:projection` strips a page's server exports — `loader` and
      // friends — before React's babel pass sees the module, so Fast Refresh
      // never registers a refresh boundary for an export that is not supposed
      // to reach the browser at all.
      //
      // BEFORE `options.plugins` so an application can still override.
      ...(await resolveReactFastRefreshPlugins({ webRoot: options.webRoot })),
      ...(options.plugins ?? []),
    ],
    server: {
      middlewareMode: true,
      hmr: { server: options.hmrServer },
      fs: {
        // `<Scripts />` points the browser at the hydration client entry under
        // `<webRoot>`: the published `esm/entry/index.mjs` when installed,
        // or `src/entry/index.ts` in this checkout. A dependency normally
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
            ...withRealPath(options.workspaceRoot),
            ...withRealPath(options.appRoot),
            ...withRealPath(options.webRoot),
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
     *   `<app>/node_modules/@warlock.js/web/esm/entry/index.mjs`.
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
     * resolves to `web/src/entry/index.ts`, a path with no `node_modules`
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
      external: [...CORE_OPTIONAL_PEERS, ...WEB_OPTIONAL_PEERS, ...(options.ssrExternal ?? [])],
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
        ...(options.resolveAlias ?? []),
        // The app-tree convention `v5/app/tsconfig.json`'s own `paths` declare.
        // Vite does not read tsconfig paths on its own and no
        // `vite-tsconfig-paths` plugin is installed in this workspace.
        //
        // ONE definition, shared with the production build contribution
        // (`web/src/build/contribution.ts`). These were two separate literals
        // until 2026-08-24, and the production half simply did not have them —
        // dev resolved `web/*` while the production client build died on the
        // first page. Do not inline them back here.
        ...appConventionAliases(options.appSrcRoot),
      ],
    },
  };
}
