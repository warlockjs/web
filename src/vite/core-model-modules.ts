import { fileURLToPath } from "node:url";
import type { DevelopmentModelModules } from "@warlock.js/core";
import { normalizePath, type Plugin } from "vite";
import {
  invalidateWithImporters,
  isSsrEnvironment,
  moduleIdPath,
  trampoline,
  versionedUrl,
} from "./dev-module-bridge";

/**
 * Makes Vite's development SSR graph read Core-loaded model modules through
 * Node's already-live file URL, rather than through a second Vite evaluation.
 */
export function coreModelModules(registry?: DevelopmentModelModules): Plugin {
  let unsubscribe: (() => void) | undefined;
  const bridgedIdsByUrl = new Map<string, Set<string>>();

  const dispose = () => {
    unsubscribe?.();
    unsubscribe = undefined;
  };

  return {
    name: "warlock:core-model-modules",
    enforce: "post",
    applyToEnvironment: (environment) => environment.config.consumer === "server",
    transform(_code, id, options) {
      if (!isSsrEnvironment(this, options?.ssr)) return null;

      const absolutePath = moduleIdPath(id);
      if (!absolutePath || !registry) return null;

      const entry = registry.get(absolutePath);
      if (!entry) return null;
      if (entry.state === "removed") {
        throw new Error(`[warlock:web] Core model module was removed: ${absolutePath}`);
      }

      const liveUrl = versionedUrl(entry.url, entry.generation);
      const bridgedIds = bridgedIdsByUrl.get(entry.url) ?? new Set<string>();
      bridgedIds.add(normalizePath(absolutePath));
      bridgedIds.add(normalizePath(id));
      bridgedIdsByUrl.set(entry.url, bridgedIds);
      return { code: trampoline(liveUrl, entry.hasDefault), map: null };
    },
    configureServer(server) {
      if (!registry) return;
      unsubscribe = registry.subscribe((entry) => {
        // The entry carries Core's exact Node URL; it is also the only stable
        // path available to subscribers for a removal notification.
        if (!entry.url) return;
        invalidateWithImporters(
          server,
          fileURLToPath(entry.url),
          bridgedIdsByUrl.get(entry.url) ?? new Set(),
        );
      });
    },
    buildEnd: dispose,
    closeBundle: dispose,
  };
}
