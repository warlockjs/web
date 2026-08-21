/**
 * One-command dev entrypoint: `npm run dev` (from `web/`) boots
 * `startDevServer()` (`./dev-server.ts`) and prints the listening URL.
 *
 * Runs under `tsx` (the runner this monorepo already ships —
 * `node_modules/.bin/tsx`, used by e.g. `builder/sources/create-warlock`'s
 * scripts). Same A.3 §2 exception as `dev-server.ts`'s header: this is a
 * monorepo-internal bootstrap, not part of the shipped package surface.
 *
 * The `registerHooks` block below solves, for a plain Node/tsx process, the
 * exact problem `web/vitest.config.ts:9-39` / `core/vitest.config.ts:13-28`
 * solve for vitest runs: core's sources import `@warlock.js/*` siblings by
 * bare specifier, every sibling's package.json points `main` at a compiled
 * `esm/` that is not built in this checkout, so default resolution dies on
 * the first such import. Outside vitest there is no Vite resolver to alias
 * through, so the same exact-match-to-source mapping is installed as a Node
 * resolve hook instead (sync `module.registerHooks`, Node >= 22.15 — this
 * checkout runs Node 24). tsx's own loader still compiles the resolved `.ts`
 * files; the hook only redirects the specifier. `dev-server.ts` is imported
 * DYNAMICALLY, after the hook is registered, so core's transitive imports are
 * resolved under it. The package list is `dev-server.ts`'s
 * `WORKSPACE_SIBLINGS` plus `core` itself (aliased there via its own
 * `CORE_SRC_INDEX` entry rather than the list).
 */
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../");

const SOURCE_ALIASED_PACKAGES = [
  "core",
  "seal",
  "cascade",
  "context",
  "logger",
  "cache",
  "fs",
  "auth",
  "herald",
  "access",
  "ai",
  "notifications",
];

registerHooks({
  resolve(specifier, context, nextResolve) {
    const match = /^@warlock\.js\/([a-z-]+)$/.exec(specifier);

    if (match && SOURCE_ALIASED_PACKAGES.includes(match[1])) {
      return {
        url: pathToFileURL(path.join(REPO_ROOT, match[1], "src/index.ts")).href,
        shortCircuit: true,
      };
    }

    return nextResolve(specifier, context);
  },
});

const { startDevServer } = await import("./dev-server");

const handle = await startDevServer();

console.log(`Warlock dev server listening on http://127.0.0.1:${handle.port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void handle.close().then(() => process.exit(0));
  });
}
