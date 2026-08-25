/**
 * `webConnector()` — the ONE thing `warlock.config.ts` imports from
 * `@warlock.js/web/connector`, and the only value the `./connector` barrel
 * adds beyond the build/runtime seams.
 *
 * WHY THIS MODULE EXISTS AT ALL, rather than the barrel exporting
 * `WebConnector` directly: `./web-connector.ts` imports `../vite`
 * (`web-connector.ts:52` → `@babel/parser` + `magic-string`),
 * `../../../core/src/router/router` (`:51`) and `./dev-server` (`:53`, which
 * itself pulls core's http stack and `../vite`) at VALUE level. Re-exporting
 * that class from `web/src/connector/index.ts` would drag every one of those
 * into the static graph of every consuming app's config file — the exact
 * config-load weight the `./connector` subpath was created to prevent.
 *
 * So the factory returns a LAZY DELEGATE: a `Connector` whose identity fields
 * (`name`, `priority`, `lifecyclePhase`, `build`) are plain data available
 * synchronously, and whose lifecycle methods `await import("./web-connector")`
 * on first use. `warlock build` reads `build` off this object and never boots
 * anything, so a build never loads Vite or React through
 * here either. This is the third instance of a pattern the codebase already
 * uses twice — `core/src/connectors/access-connector.ts:39` and
 * `web/src/server/dev-cli.ts:61` — not a new one.
 *
 * KEEP THIS MODULE LIGHT. Its whole value-level static graph is `node:path`,
 * `node:url`, `../../../core/src/connectors/types` (whose own two imports are
 * both `import type` and therefore erased — `core/src/connectors/types.ts:1-2`)
 * and `../build/contribution` (`node:fs` + `node:path` + type-only core).
 * Everything else here is `import type`, which `verbatimModuleSyntax` erases.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Connector,
  type ConnectorBuildContribution,
  ConnectorLifecyclePhase,
  type ConnectorName,
} from "@warlock.js/core";
import { createWebBuildContribution, type WebBuildOptions } from "../build/contribution";
import type { WebConnector, WebConnectorOptions } from "./web-connector";

/**
 * Boot/shutdown position relative to core's own connectors.
 *
 * `ConnectorPriority.HTTP` is `5` and `ConnectorPriority.STORAGE` is `6`
 * (`core/src/connectors/types.ts:187-188`), and the manager sorts on a plain
 * numeric compare (`core/src/connectors/connectors-manager.ts:46`) — so `5.5`
 * is "immediately after http, before everything else".
 *
 * Defined HERE and re-exported by `./web-connector` rather than the other way
 * round: the delegate must publish `priority` synchronously, and reading it
 * from the heavy module would defeat the whole point of the delegate.
 */
export const WEB_CONNECTOR_PRIORITY = 5.5;

export type WebConnectorFactoryOptions = WebConnectorOptions & {
  /**
   * What web contributes to `warlock build`. Passed straight to
   * {@link createWebBuildContribution}; JSON-serializable values only — no
   * plugin or pipeline instances, so a config load never pulls Vite in.
   */
  build?: WebBuildOptions;
};

/**
 * The `@warlock.js/web` package root, derived once from THIS module's location
 * and then passed EXPLICITLY to both halves.
 *
 * `web/src/server/web-connector-factory.ts` → `web/src/server` → `web/src` →
 * `web`; published as `web/esm/server/web-connector-factory.js`, two levels up
 * is the package root under both layouts — the same arithmetic
 * `contribution.ts:136-140` documents.
 *
 * Deriving it here and handing it down means the build contribution never falls
 * back to its own `import.meta.url` guess (`contribution.ts:129-141`): one
 * derivation, one place to be wrong, and `assertWebPackageRoot` verifies it
 * against `<root>/package.json`'s `name` either way.
 */
function deriveWebRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Construct web's connector for `warlock.config.ts > connectors`.
 *
 * @example
 * ```ts
 * export default defineConfig({ connectors: [webConnector()] });
 * ```
 */
export function webConnector(options: WebConnectorFactoryOptions = {}): Connector {
  const { build: buildOptions, ...connectorOptions } = options;
  const webRoot = connectorOptions.webRoot ?? deriveWebRoot();

  const build: ConnectorBuildContribution = createWebBuildContribution({
    ...buildOptions,
    webRoot: buildOptions?.webRoot ?? webRoot,
  });

  let instance: WebConnector | undefined;

  /**
   * Load the heavy half on first lifecycle call. `boot()` is always the first
   * of these to run (`core/src/connectors/connectors-manager.ts:87-93`), so the
   * import lands in a process that has already committed to serving pages.
   */
  const load = async (): Promise<WebConnector> => {
    if (!instance) {
      const { WebConnector: WebConnectorClass } = await import("./web-connector");

      instance = new WebConnectorClass({ ...connectorOptions, webRoot });
    }

    return instance;
  };

  return {
    name: "web" satisfies ConnectorName,
    priority: WEB_CONNECTOR_PRIORITY,
    lifecyclePhase: ConnectorLifecyclePhase.Late,
    build,

    // Never loads the heavy half: a connector that was never booted is not
    // active, and answering that must not cost a Vite import.
    isActive: () => instance?.isActive() ?? false,

    boot: async () => {
      await (await load()).boot();
    },
    start: async () => {
      await (await load()).start();
    },
    restart: async () => {
      await (await load()).restart();
    },

    // Both of these are asked of every registered connector, including ones
    // that never booted — so neither may force the import.
    shutdown: async () => {
      await instance?.shutdown();
    },
    shouldRestart: () => false,
  };
}
