import type { Plugin, PluginOption } from "vite";
import { createHydrationClientEntry } from "./hydration-entries";

/** `@vitejs/plugin-react`'s default export, plus the one static it publishes. */
type ReactPluginFactory = ((options?: Record<string, unknown>) => PluginOption[]) & {
  preambleCode?: string;
};

/** POSIX-normalised, case-folded — Vite ids are `/`-separated on Windows too. */
function normalizeModuleId(id: string): string {
  const [filepath] = id.split("?");

  return filepath.replace(/\\/g, "/").toLowerCase();
}

/**
 * Public specifier for the React Fast Refresh preamble module this connector
 * injects. See {@link resolveReactFastRefreshPlugins}.
 */
const REACT_REFRESH_PREAMBLE_ID = "virtual:warlock/react-refresh-preamble";

/** The `\0`-prefixed form Rollup uses to mark a module as not-a-file. */
const RESOLVED_REACT_REFRESH_PREAMBLE_ID = `\0${REACT_REFRESH_PREAMBLE_ID}`;

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
 * `buildWarlockHydrationClient` (`./index.ts:185`), which composes
 * `warlockClientBoundary()` and nothing else, and never calls this method.
 *
 * @param paths resolved by `WebConnector.resolvePaths`
 */
export async function resolveReactFastRefreshPlugins(paths: {
  webRoot: string;
}): Promise<PluginOption[]> {
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
        '"can\'t detect preamble" in the browser.',
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
    applyToEnvironment: (environment) => environment.config.consumer === "client",
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
