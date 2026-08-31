import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Resolve a sibling workspace package to its TypeScript source entry.
 *
 * The SAME workaround core's own suite uses (core/vitest.config.ts:16-28, with
 * its rationale at :3-11): several `@warlock.js/*` packages declare
 * `main`/`module` pointing at a compiled `cjs`/`esm` directory that is not
 * built inside this monorepo checkout, so Vite cannot resolve them by name.
 * The P1 server specs (`__tests__/server/`) construct REAL core
 * `Request`/`Response` instances via relative imports into `core/src`, and
 * core's sources import these siblings by package name — without the aliases
 * the first `@warlock.js/seal` / `@warlock.js/cascade` import dies on the
 * missing build output.
 *
 * Exact-match regexes, NOT the plain-string (prefix) alias form core uses:
 * Kepler's vite fixtures import subpaths like
 * `@warlock.js/seal/validators/any-validator`
 * (__tests__/vite/fixtures/gate-a/.../case4-seal-import.page.tsx:17), and a
 * prefix alias would corrupt any such specifier that ever hits the resolver.
 */
const workspaceSource = (packageName: string) => {
  return path.resolve(__dirname, `../${packageName}/src/index.ts`);
};

const exactAlias = (packageName: string) => ({
  find: new RegExp(`^@warlock\\.js/${packageName}$`),
  replacement: workspaceSource(packageName),
});

const alias = [
  exactAlias("seal"),
  exactAlias("cascade"),
  exactAlias("context"),
  exactAlias("logger"),
  exactAlias("cache"),
  exactAlias("fs"),
  exactAlias("auth"),
  exactAlias("herald"),
];

export default defineConfig({
  resolve: { alias },
  test: {
    /**
     * Pin NODE_ENV for the whole suite.
     *
     * Vitest only defaults this to "test" when it is UNSET — an ambient
     * `NODE_ENV=production` in the developer's shell (or a CI image) is
     * inherited instead, and the suite then silently exercises production
     * branches. That is not hypothetical: this machine exports
     * `NODE_ENV=production`, which put `buildErrorRecord()` on its scrubbing
     * path and `serializePageError()` on its stack-withholding path, and
     * `render-page.spec.ts`'s hydratable-error-page case failed for that
     * reason alone while the code under it was correct.
     *
     * A test whose verdict tracks the machine it runs on is worse than a
     * failing one. Specs that want the production branch should set it
     * themselves, per-test, and restore it after.
     */
    env: { NODE_ENV: "test" },
    environment: "node",
    projects: [
      {
        resolve: { alias },
        test: {
          name: "web",
          environment: "node",
          include: ["src/**/*.spec.ts"],
          exclude: ["src/vite/**/*.spec.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "web-tests",
          environment: "node",
          // The package-level suites: A.3's shared specs and P1's server
          // (pipeline) specs — the latter import REAL core classes and are
          // why the aliases exist at all.
          include: ["__tests__/**/*.spec.ts"],
          // The server specs re-import the core graph cold (`vi.resetModules()`
          // then `core/src/http/request` -> `@warlock.js/seal`,
          // `@warlock.js/cascade`, all aliased to TypeScript SOURCE above), and
          // the first case in a file pays the whole transform. Measured: ~15-23s
          // on an idle machine, and 53.4s with 16 busy CPU workers on 12 cores.
          // The old 30s budget sat between those two numbers, so the suite's
          // pass/fail tracked machine load rather than the code — it failed at
          // 30342/30003/30094/30013ms under concurrent load. The budget is scoped
          // to this project, so `web` and the unit suites keep vitest's 5s default
          // and still catch genuinely slow tests.
          //
          // 2026-08-24 — raised 90s -> 180s. The server specs now reach core
          // through `@warlock.js/core` (the package name) rather than through
          // `core/src/<module>` paths, which is a deliberate change and NOT a
          // regression: the root barrel re-exports every core subsystem, so each
          // `vi.resetModules()` re-evaluates all of it instead of the seven
          // modules the connector actually names.
          //
          // Measured on the same suite, changing only the import style:
          //   deep imports  58.7s wall — green
          //   package name  127-167s wall — `web-connector-production.spec.ts`
          //                 timed out at the old 90s budget, twice, while passing
          //                 standalone in 33s
          // A later run of the identical package-name configuration came in at
          // 85.3s and green. The spread is real: this suite's cost tracks machine
          // load, which is the whole reason the budget has to sit well above the
          // typical number rather than just above it.
          //
          // The barrel is right at RUNTIME — a Warlock process loads all of core
          // regardless, and the connector shares that process. The cost is an
          // artefact of `freshWebGraph()` re-importing under `vi.resetModules()`.
          //
          // Fixing it for real means core exposing per-subsystem subpath entries
          // in `builder/pkgist.config.ts` AND its `exports` map together; adding
          // them to only one would resolve in-repo and fail once published.
          // NOTE for whoever tries: giving core an `exports` map was attempted on
          // 2026-08-24 and REVERTED. It doubled core's own test execution time
          // (121.7s -> 258.3s) and took core from 1 failing test to 8, and it
          // doubled this suite too (85.3s -> 180.1s). Unproven suspicion: the map
          // yields a different module id than the relative paths core's tests
          // use, so core gets instantiated twice. Answer that before retrying.
          testTimeout: 180_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "web-vite",
          environment: "node",
          include: ["src/vite/**/*.spec.ts"],
          // Cold-cache import of this suite runs ~26s (warm ~10-15s) vs.
          // vitest's 5s default; scoped here only so other suites keep
          // catching genuinely slow tests.
          testTimeout: 30_000,
        },
      },
    ],
  },
});
