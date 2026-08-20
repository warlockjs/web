import type { SharedContext } from "./index";

const notImplemented = () =>
  new Error("@warlock.js/web is not implemented yet");

/**
 * The WRITABLE per-request payload — middleware's half of the contract
 * (base.middleware.ts:71-88 is the canonical writer).
 *
 * The real implementation is an AsyncLocalStorage-backed proxy: the module
 * scope holds a resolver, never data, which is what separates this from the
 * five banned module-global imports (base.middleware.ts:19-46 states the
 * argument in full). It must THROW outside a request rather than fall back to
 * a shared object, and it is SEALED before the first loader runs. The M1
 * skeleton throws on every access, which is the not-implemented degenerate
 * case of both properties.
 */
export const shared: SharedContext = new Proxy({} as SharedContext, {
  get() {
    throw notImplemented();
  },
  set() {
    throw notImplemented();
  },
});

/**
 * The READ half, for components, from depth (user-menu.tsx:27-33 is the one
 * use in the reference app). Same object the page and layout props carry —
 * not a copy, not a module global — readonly because components may never
 * write it: writes are middleware work, before the seal.
 */
export function useShared(): Readonly<SharedContext> {
  throw notImplemented();
}
