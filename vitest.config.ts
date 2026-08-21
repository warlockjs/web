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
