export {
  DEFER_BOOTSTRAP_SOURCE,
  installStreamClosedRejection,
  prepareDeferredPageData,
  type DeferredSettlement,
} from "./defer-registry";
export { DeferredStreamClosedError } from "./deferred-stream-closed-error";
export { DeferredValueError } from "./deferred-value-error";
export { loadClientRouteComposition, validateClientRouteManifest } from "./manifest";
// @deprecated — see matcher.ts:221 for replacement and deletion condition
export { matchClientRoute } from "./matcher";
// Projected page/layout/root modules use this same guard for HMR replacement
// namespaces, so a later route composition cannot run the replacement hook again.
export { registerModules } from "../../register-modules";
export type {
  ClientPageEntry,
  ClientProjectedModule,
  ClientRouteComposition,
  ClientRouteLoad,
  ClientRouteMatch,
  ClientRouteParams,
} from "./types";
