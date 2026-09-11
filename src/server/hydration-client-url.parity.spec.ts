/**
 * PARITY GATE — row 10 of `release/b8e6ede3-parity-surface.md`.
 *
 * The hydration client entry URL is resolved from two different places: dev
 * builds a `/@fs/<absolute path>` URL from the entry description
 * (`../vite/hydration-entries.ts`), production reads Vite's emitted
 * `manifest.json` (`./hydration-client-url.ts`). The two cannot be diffed
 * directly — by design they produce different URLs, because dev serves the
 * source through Vite's module graph and production serves a hashed asset.
 *
 * What they DO share is a contract, held in two constants:
 *
 *   HYDRATION_CLIENT_ENTRY_NAME — the Rollup input name the build writes and
 *     the manifest lookup searches for
 *   CLIENT_ASSET_URL_PREFIX — the directory the built file must land under,
 *     which is also where the production static-file route is mounted
 *
 * Row 10 recorded that contract as verified by READING and explicitly NOT by
 * execution: nothing ran the real build and handed its real manifest to the
 * real resolver. Every existing case in `./hydration-client-url.spec.ts` feeds
 * the resolver a hand-written manifest, and `__tests__/server/
 * web-connector-production.spec.ts` mocks `resolveHydrationClientUrl`
 * outright. So a change to the build's `entryFileNames`, its `manifest` flag,
 * or its input key would leave every one of those green while production
 * failed to boot — the build and the resolver are two files that must agree
 * and nothing made them prove it.
 *
 * This closes that: a real `buildHydrationClient()` over a fixture entry,
 * using the production build configuration as it actually ships, and then the
 * real `resolveHydrationClientUrl()` over the manifest that build emitted.
 * The fixture supplies only the ENTRY — the config under test is the real one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HYDRATION_CLIENT_ENTRY_NAME } from "../vite/hydration-entries";
import { buildHydrationClient } from "../vite/build-client";
import { CLIENT_ASSET_URL_PREFIX } from "./client-asset-url-prefix";
import {
  resolveHydrationClientUrl,
  WebClientAssetPrefixViolationError,
  WebClientManifestEntryMissingError,
} from "./hydration-client-url";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);

  return root;
}

/**
 * A fixture `@warlock.js/web` root holding only the checkout-shaped hydration
 * entry, which is all `createHydrationClientEntry` needs to resolve.
 *
 * Deliberately NOT the framework's real entry: that one pulls React and the
 * whole client runtime in, which would make this a test of the bundle's
 * contents. The subject here is the build CONFIGURATION's agreement with the
 * manifest READER, and that agreement is identical whatever the entry imports.
 */
function makeFixtureWebRoot(): string {
  const webRoot = makeTemporaryDirectory("warlock-hydration-entry-");
  const entryFile = path.join(webRoot, "src", "entry", "index.ts");

  fs.mkdirSync(path.dirname(entryFile), { recursive: true });
  fs.writeFileSync(
    entryFile,
    'export function hydrate(): string {\n  return "fixture";\n}\n',
    "utf-8",
  );

  return webRoot;
}

/** Runs the REAL client build over the fixture entry and returns its client dir. */
async function buildFixtureClient(): Promise<string> {
  const clientDir = makeTemporaryDirectory("warlock-hydration-client-");
  const appRoot = makeTemporaryDirectory("warlock-hydration-app-");

  await buildHydrationClient({
    webRoot: makeFixtureWebRoot(),
    outDir: clientDir,
    // `assertBuildOptions` refuses an empty plugin list, and the real caller
    // always composes one. A no-op plugin satisfies that without adding any
    // behaviour the build under test would otherwise not have.
    plugins: [{ name: "warlock-hydration-parity-fixture" }],
    // `assertBuildOptions` also refuses an EMPTY alias table, because app
    // source importing via `web/*` or `app/*` cannot resolve without one. The
    // fixture entry imports nothing, but the guard is a real contract of the
    // function under test, so the fixture satisfies it rather than routing
    // around it.
    resolveAliases: { "app/": `${appRoot}/` },
  });

  return clientDir;
}

/** The manifest the build actually emitted, as the resolver reads it. */
function readEmittedManifest(clientDir: string): Record<string, Record<string, unknown>> {
  const manifestPath = path.join(clientDir, ".vite", "manifest.json");

  return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<
    string,
    Record<string, unknown>
  >;
}

function writeManifest(clientDir: string, manifest: unknown): void {
  fs.writeFileSync(
    path.join(clientDir, ".vite", "manifest.json"),
    JSON.stringify(manifest),
    "utf-8",
  );
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe("hydration client URL — real build meets real resolver", () => {
  // A real Vite client build, competing with ~88 other files for CPU under the
  // full suite. At vitest's 5s default a build-backed gate reports machine load
  // as a property of the code (canon `c9f300bb`); it states its own budget.
  const REAL_BUILD_TIMEOUT_MS = 60_000;

  it(
    "resolves a URL from the manifest the production build actually writes",
    async () => {
      const clientDir = await buildFixtureClient();

      const url = resolveHydrationClientUrl({ clientDir });

      // The whole point of the row: not that the resolver handles SOME
      // manifest, but that it handles the one today's build emits.
      expect(url.startsWith(`${CLIENT_ASSET_URL_PREFIX}/`)).toBe(true);
      expect(fs.existsSync(path.join(clientDir, url.replace(/^\//, "")))).toBe(true);
    },
    REAL_BUILD_TIMEOUT_MS,
  );

  it(
    "emits exactly one entry, named by the constant both sides share",
    async () => {
      const clientDir = await buildFixtureClient();
      const manifest = readEmittedManifest(clientDir);

      const entries = Object.values(manifest).filter((entry) => entry.isEntry === true);

      // If the build ever emits a second entry, "find the hydration entry"
      // stops being unambiguous and the resolver's first match becomes load
      // bearing by accident rather than by contract.
      expect(entries).toHaveLength(1);

      // Read through a named binding rather than indexing inline: under
      // `noUncheckedIndexedAccess` an index access is `T | undefined`, and the
      // `toHaveLength` above does not narrow it. Asserting the binding is
      // defined states the same expectation the length check does, in the form
      // the compiler can follow.
      const [hydrationEntry] = entries;

      expect(hydrationEntry).toBeDefined();
      expect(hydrationEntry?.name).toBe(HYDRATION_CLIENT_ENTRY_NAME);
    },
    REAL_BUILD_TIMEOUT_MS,
  );

  it(
    "goes red when the build's entry name drifts from the reader's constant",
    async () => {
      // Red control 1 — the drift this pair of constants exists to prevent.
      // Injected into the REAL manifest so it proves the gate depends on the
      // build's output, not on a fixture the test wrote itself.
      const clientDir = await buildFixtureClient();
      const manifest = readEmittedManifest(clientDir);

      for (const entry of Object.values(manifest)) {
        if (entry.isEntry === true) {
          entry.name = "client";
        }
      }

      writeManifest(clientDir, manifest);

      expect(() => resolveHydrationClientUrl({ clientDir })).toThrow(
        WebClientManifestEntryMissingError,
      );
    },
    REAL_BUILD_TIMEOUT_MS,
  );

  it(
    "goes red when the built file lands outside the shared asset prefix",
    async () => {
      // Red control 2 — the other half of the contract. A build whose
      // `entryFileNames` stopped writing into the assets directory would serve
      // a 404 for the hydration script, and the page would render and never
      // come alive.
      const clientDir = await buildFixtureClient();
      const manifest = readEmittedManifest(clientDir);

      for (const entry of Object.values(manifest)) {
        if (entry.isEntry === true) {
          entry.file = "hydration-elsewhere.js";
        }
      }

      writeManifest(clientDir, manifest);

      expect(() => resolveHydrationClientUrl({ clientDir })).toThrow(
        WebClientAssetPrefixViolationError,
      );
    },
    REAL_BUILD_TIMEOUT_MS,
  );
});
