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
          // 30342/30003/30094/30013ms under concurrent load. 90s clears the
          // measured contended cost with room, and is scoped to this project, so
          // `web` and the unit suites keep vitest's 5s default and still catch
          // genuinely slow tests. The transform cost itself is the real defect;
          // this only stops it from being reported as flakiness.
          testTimeout: 90_000,
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
