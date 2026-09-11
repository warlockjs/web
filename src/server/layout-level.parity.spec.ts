/**
 * PARITY GATE — row 2 of `release/b8e6ede3-parity-surface.md`.
 *
 * Dev and production agree about a page's layout LEVEL, and this proves the
 * half of that claim which is not already true by construction.
 *
 * The chain half needs no gate: both modes derive the chain from ONE function,
 * `layoutChainFor` (`../build/discover-pages.ts`). Dev calls it at install time
 * (`./install-page-routes.ts`); the BUILD calls the same function and records
 * its result as `page.layouts`, which `./install-page-routes-from-manifest.ts`
 * walks in order. Diffing the two chains would diff one function against
 * itself.
 *
 * What is NOT shared is where each layout's module namespace is READ FROM. Dev
 * reads a live `vite.ssrLoadModule()` result; production reads the built
 * barrel's namespace off `page.layouts[].module`. Both then take exactly two
 * fields from it:
 *
 *   renders: typeof module.default !== "undefined"
 *   prefix:  module.prefix
 *
 * Those two fields decide which layout hosts the page and what URL the page
 * answers on. A build that drops, renames or tree-shakes either one produces a
 * page that renders and routes correctly in dev and wrongly in production —
 * the row 12 defect shape, where a build step silently loses something the dev
 * path still sees.
 *
 * So this runs ONE fixture through BOTH module-loading paths for real — a real
 * Vite SSR build and a real Vite dev server — and diffs the `LayoutLevel` the
 * shared rule computes from each. The shared rule is deliberately the same
 * call on both sides: the rule is not what is under test, the two readings of
 * the module are.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, createServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { type LayoutLevel, resolveLayoutLevel } from "../routing/layout-level";

const temporaryDirectories: string[] = [];

/** Materialises a fixture tree: `{ "src/web/layout.ts": "..." }` under a temp root. */
function makeTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-layout-level-"));
  temporaryDirectories.push(root);

  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf-8");
  }

  return root;
}

/**
 * The fixture's layout chain, outermost first, with the page it wraps.
 *
 * Exercises every shape the two read fields can take, because a build can lose
 * them independently:
 *
 * - outer: declares a prefix, renders NOTHING — the shape where a tree-shaker
 *   has a live reason to drop the module's only remaining export
 * - second: declares NEITHER — proves an absent prefix survives as absent
 *   rather than arriving as `""`, which composes differently
 * - third: a second prefix-only layout, so composition ORDER is observable
 *   rather than incidental
 * - inner: renders AND declares a prefix — both fields load-bearing at once
 *
 * Exactly ONE layout renders, because more than one is refused outright by
 * `resolveLayoutLevel` (`NestedLayoutsNotSupportedError`). A fixture that
 * ignored that rule would not be a harder test, it would be an invalid app —
 * the first draft of this file was, and the rule caught it.
 */
const FIXTURE = {
  "src/web/layout.ts": 'export const prefix = "/shop";\n',
  "src/web/account/layout.ts": "export const unrelated = true;\n",
  "src/web/account/settings/layout.ts": 'export const prefix = "/settings";\n',
  "src/web/account/settings/profile/layout.ts":
    'export const prefix = "/profile";\nexport default function Inner() {}\n',
  "src/web/account/settings/profile/index.page.ts": "export default function Page() {}\n",
} as const;

/** The chain `layoutChainFor` produces for the fixture page, outermost first. */
const CHAIN = [
  "src/web/layout.ts",
  "src/web/account/layout.ts",
  "src/web/account/settings/layout.ts",
  "src/web/account/settings/profile/layout.ts",
] as const;

const PAGE = "src/web/account/settings/profile/index.page.ts";

/** The two fields both installers take off a layout module namespace, and nothing else. */
type LayoutReading = {
  renders: boolean;
  prefix: string | undefined;
};

function readLayout(module: Record<string, unknown>): LayoutReading {
  return {
    renders: typeof module.default !== "undefined",
    prefix: module.prefix as string | undefined,
  };
}

type LayoutLevelParity = {
  dev: { level: LayoutLevel; readings: LayoutReading[] };
  production: { level: LayoutLevel; readings: LayoutReading[] };
};

/**
 * Loads every layout in the chain through BOTH real pipelines and runs each
 * reading through the shared rule.
 *
 * `corruptProductionPrefix` is the red control. For a parity check, WHICH end
 * you disable IS the control (canon `87660e1e`), so it damages the PRODUCTION
 * reading only and leaves dev intact — reproducing the asymmetry of the defect
 * this gate exists to catch, rather than breaking both sides into agreement.
 */
async function collectFixtureLayoutLevels(
  options: { corruptProductionPrefix?: boolean } = {},
): Promise<LayoutLevelParity> {
  const appRoot = makeTree(FIXTURE);
  const outDir = path.join(appRoot, "dist", "server");

  // PRODUCTION: a real Vite SSR build, then import the built namespaces — the
  // same shape the generated pages barrel hands the manifest installer.
  await build({
    root: appRoot,
    configFile: false,
    logLevel: "silent",
    build: {
      ssr: true,
      minify: false,
      outDir,
      rollupOptions: {
        input: Object.fromEntries(
          CHAIN.map((file, index) => [`layout-${index}`, path.join(appRoot, file)]),
        ),
        output: { format: "es", entryFileNames: "[name].mjs" },
      },
    },
  });

  const productionModules: Record<string, unknown>[] = [];

  for (let index = 0; index < CHAIN.length; index += 1) {
    const built = path.join(outDir, `layout-${index}.mjs`);
    productionModules.push((await import(pathToFileURL(built).href)) as Record<string, unknown>);
  }

  // DEV: a real Vite dev server, loading the SOURCE files.
  const vite = await createServer({
    root: appRoot,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });

  const devModules: Record<string, unknown>[] = [];

  for (const file of CHAIN) {
    devModules.push((await vite.ssrLoadModule(`/${file}`)) as Record<string, unknown>);
  }

  await vite.close();

  const devReadings = devModules.map(readLayout);
  const productionReadings = productionModules.map(readLayout);

  if (options.corruptProductionPrefix === true) {
    // The red control's injected defect: a build that lost ONE layout's
    // `prefix` export. Applied to the OUTERMOST prefix-only layout — the shape
    // a tree-shaker is likeliest to drop, and the position where losing it
    // changes the page's whole URL rather than one segment of it.
    productionReadings[0] = { ...productionReadings[0], prefix: undefined };
  }

  const level = (readings: LayoutReading[]): LayoutLevel =>
    resolveLayoutLevel(
      PAGE,
      CHAIN.map((id, index) => ({ id, ...readings[index] })),
    );

  return {
    dev: { level: level(devReadings), readings: devReadings },
    production: { level: level(productionReadings), readings: productionReadings },
  };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe("layout level parity gate — built module vs live module", () => {
  // This case runs a REAL Vite SSR build AND a real dev server, so it is slow
  // by construction, and under the full suite it competes with ~87 other files
  // for CPU. At vitest's 5s default a build-backed gate reports machine load as
  // if it were a property of the code (canon `c9f300bb`), which is how the
  // stylesheet gate went intermittently red. A build-backed gate states its own
  // budget.
  const REAL_BUILD_TIMEOUT_MS = 60_000;

  it(
    "resolves the same layout level from a built module as from a live one",
    async () => {
      const parity = await collectFixtureLayoutLevels();

      expect(parity.production.level).toEqual(parity.dev.level);
    },
    REAL_BUILD_TIMEOUT_MS,
  );

  it(
    "reads the same renders/prefix pair off every layout in the chain",
    async () => {
      const parity = await collectFixtureLayoutLevels();

      // The level alone can agree while a reading differs — two layouts'
      // prefixes composing to the same URL, say. Diffing the readings names
      // WHICH layout drifted, which is the difference between a gate that
      // fails and a gate that explains.
      expect(parity.production.readings).toEqual(parity.dev.readings);
    },
    REAL_BUILD_TIMEOUT_MS,
  );

  it(
    "asserts the fixture actually exercises all three layout shapes",
    async () => {
      const parity = await collectFixtureLayoutLevels();

      // Without this, the gate above passes just as happily against a fixture
      // whose exports all vanished from BOTH sides — agreement about nothing.
      expect(parity.dev.readings).toEqual([
        { renders: false, prefix: "/shop" },
        { renders: false, prefix: undefined },
        { renders: false, prefix: "/settings" },
        { renders: true, prefix: "/profile" },
      ]);
      expect(parity.dev.level.prefix).toBe("/shop/settings/profile");
      // The one rendering layout hosts the page — not the nearest one.
      expect(parity.dev.level.hostId).toBe("src/web/account/settings/profile/layout.ts");
    },
    REAL_BUILD_TIMEOUT_MS,
  );

  it(
    "goes red when the build loses one layout's prefix export",
    async () => {
      // The red control, kept in the suite rather than run by hand once: this
      // is the exact failure the gate exists for — production dropping an
      // export dev still sees — and it must be the ROUTE that changes, not
      // merely a field.
      const parity = await collectFixtureLayoutLevels({ corruptProductionPrefix: true });

      expect(parity.production.level.prefix).toBe("/settings/profile");
      expect(parity.dev.level.prefix).toBe("/shop/settings/profile");
      expect(parity.production.level).not.toEqual(parity.dev.level);
    },
    REAL_BUILD_TIMEOUT_MS,
  );
});
