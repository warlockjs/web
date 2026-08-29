/**
 * The universal portion of a page or layout module namespace.
 *
 * `register` deliberately has no arguments and must finish synchronously: it
 * runs while both the server and browser evaluate the same module graph.
 */
export type RegisterableModuleNamespace = {
  readonly register?: () => unknown;
};

const registeredModules = new WeakSet<RegisterableModuleNamespace>();

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Run each module's optional universal registration hook at most once for
 * that module namespace instance. A replacement namespace from HMR naturally
 * has a new identity and is therefore registered again.
 */
export function registerModules(modules: readonly RegisterableModuleNamespace[]): void {
  for (const module of modules) {
    if (registeredModules.has(module)) continue;

    const result = module.register?.();

    if (isThenable(result)) {
      throw new Error(
        "Warlock register() hooks must be synchronous and must not return a Promise or thenable.",
      );
    }

    // A throwing hook (including one that returned a thenable above) is not
    // recorded, so a later route composition still exposes and can retry it.
    registeredModules.add(module);
  }
}
