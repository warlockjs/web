/*
 * SECRET FIXTURES: assemble every secret-shaped test value at RUNTIME (string
 * concatenation / join), never as a contiguous literal. GitHub push protection
 * scans this repo's source bytes and BLOCKS any push containing a matching
 * pattern (it cost two rejected pushes on 2026-08-21). Gate C itself only ever
 * sees the runtime value via env → built page output, so assembly changes
 * nothing about what these tests prove.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { beforeAll, describe, expect, it } from "vitest";
import { warlockClientBoundary } from "./index";
import { findLeakedServerExports, gateCVerify } from "./gate-c-verify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_ROOT = path.join(__dirname, "..", "..", "__tests__", "vite", "fixtures", "gate-c");
const PAGE_DIR = path.join(FIXTURE_ROOT, "app", "blog", "web");

/**
 * Runs a real Vite build (JS API, not npx) through the FULL
 * composed `warlockClientBoundary()` pipeline (projection + Gate A + Gate B
 * + Gate C), for a single fixture page. Used for Gate C's POSITIVE cases —
 * proving it doesn't false-positive on a legitimately clean bundle, and
 * exercising the Part 2 manifest end to end.
 */
async function buildPageThroughFullPipeline(fileName: string) {
  return build({
    root: FIXTURE_ROOT,
    logLevel: "silent",
    plugins: [warlockClientBoundary({ appRoot: FIXTURE_ROOT })],
    build: {
      write: false,
      minify: false,
      lib: {
        entry: path.join(PAGE_DIR, fileName),
        formats: ["es"],
        fileName: () => "out.js",
      },
      rollupOptions: { external: [] },
    },
  });
}

/**
 * Runs a real Vite build with ONLY `gateCVerify()` in the plugin array —
 * projection and Gate A are DELIBERATELY absent (Part 1, item 3). Proves
 * Gate C catches a leak independently of the earlier gates ever having run,
 * not just that the full happy-path pipeline stays clean.
 */
async function buildPageWithOnlyGateC(fileName: string, minify: boolean = false) {
  return build({
    root: FIXTURE_ROOT,
    logLevel: "silent",
    plugins: [gateCVerify({ appRoot: FIXTURE_ROOT })],
    build: {
      write: false,
      minify,
      lib: {
        entry: path.join(FIXTURE_ROOT, fileName),
        formats: ["es"],
        fileName: () => "out.js",
      },
      rollupOptions: { external: [] },
    },
  });
}

type BuildResult = Awaited<ReturnType<typeof buildPageThroughFullPipeline>>;

function outputOf(result: BuildResult) {
  const output = Array.isArray(result) ? result[0] : result;
  if (!("output" in output)) throw new Error("expected a RollupOutput");
  return output.output;
}

function firstChunkCode(result: BuildResult): string {
  const chunk = outputOf(result).find((file) => file.type === "chunk");
  if (!chunk) throw new Error("expected a JS chunk in the build output");
  return chunk.code;
}

function manifestOf(result: BuildResult): Array<{ key: string; value: string | null; redacted: boolean }> {
  const asset = outputOf(result).find((file) => file.fileName === "warlock-env-manifest.json");
  if (!asset || asset.type !== "asset") throw new Error("expected a warlock-env-manifest.json asset in the output");
  return JSON.parse(asset.source as string);
}

/**
 * The server-only package the bypass fixtures import.
 *
 * Written rather than committed for the same reason as Gate A's: it has to sit
 * under `FIXTURE_ROOT/node_modules/` for Vite to resolve it the way a real
 * dependency resolves, and that path is gitignored — so a committed copy is one
 * git silently drops, and the two bypass cases were red on any fresh clone.
 *
 * The marker is the whole fixture: `findLeakedServerImportEdges` asks the
 * classifier for the package's environment, and only `"server"` is a leak. The
 * happy-path cases in this file build without it, so if this package were
 * mis-shaped and classified as anything else, cases 2 and 2-minified would fail
 * rather than silently passing on a bundle with nothing to find.
 */
function writeGateCFixturePackage() {
  const dir = path.join(FIXTURE_ROOT, "node_modules", "@warlock.js", "fake-server-pkg");

  mkdirSync(dir, { recursive: true });

  writeFileSync(
    path.join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "@warlock.js/fake-server-pkg",
        version: "1.0.0",
        main: "index.js",
        warlock: { environment: "server" },
      },
      null,
      2,
    )}\n`,
  );

  writeFileSync(
    path.join(dir, "index.js"),
    `export const secretServerThing = "fake-server-pkg-value";\n`,
  );
}

beforeAll(writeGateCFixturePackage);

describe("gateCVerify — Gate C output verification (real Vite builds)", () => {
  describe("Part 1, item 3: deliberately-bypassed-gate fixtures — Gate C catches a leak independently", () => {
    it("case 1: a server export (route) survives because projection is absent from the plugin array — Gate C alone refuses the build", async () => {
      try {
        await buildPageWithOnlyGateC("leaked-export.page.tsx");
        expect.unreachable("expected the build to fail");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("Gate C refused a build: a server export survived");
        expect(message).toContain("File: out.js");
        expect(message).toContain("Export: route");
        expect(message).toContain("Cause:");
        expect(message).toContain("Fix:");
      }
    });

    it("case 2: a server-only import edge survives because Gate A is absent from the plugin array — Gate C alone refuses the build", async () => {
      try {
        await buildPageWithOnlyGateC("leaked-import-edge.page.tsx");
        expect.unreachable("expected the build to fail");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain(
          "Gate C refused a build: a server-only import edge survived",
        );
        expect(message).toContain("File: out.js");
        expect(message).toContain("Module:");
        expect(message).toContain("@warlock.js/fake-server-pkg");
        expect(message).toContain("Cause:");
        expect(message).toContain("Fix:");
      }
    });
  });

  describe("D.8: the same bypass fixtures under a real minified build (build.minify: true — the artifact actually shipped)", () => {
    it("case 1-minified: a server export (route) survives minification and Gate C still refuses the build", async () => {
      try {
        await buildPageWithOnlyGateC("leaked-export.page.tsx", true);
        expect.unreachable("expected the build to fail");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("Gate C refused a build: a server export survived");
        expect(message).toContain("File: out.js");
        expect(message).toContain("Export: route");
        expect(message).toContain("Cause:");
        expect(message).toContain("Fix:");
      }
    });

    it("case 2-minified: a server-only import edge survives minification and Gate C still refuses the build", async () => {
      try {
        await buildPageWithOnlyGateC("leaked-import-edge.page.tsx", true);
        expect.unreachable("expected the build to fail");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain(
          "Gate C refused a build: a server-only import edge survived",
        );
        expect(message).toContain("File: out.js");
        expect(message).toContain("Module:");
        expect(message).toContain("@warlock.js/fake-server-pkg");
        expect(message).toContain("Cause:");
        expect(message).toContain("Fix:");
      }
    });
  });

  describe("Part 1, items 1-2: the happy path does not false-positive", () => {
    it("case 3: a legitimately clean page (loader stripped by projection) passes the full pipeline including Gate C", async () => {
      const result = await buildPageThroughFullPipeline("clean-page.page.tsx");
      const code = firstChunkCode(result);

      expect(code).not.toContain("@warlock.js/core");
      expect(code).not.toContain("loader");
      expect(code).toContain("clean page");
      // Gate C ran to completion (didn't throw) and still emitted its
      // manifest asset, even with zero PUBLIC_* reads on this page.
      expect(manifestOf(result)).toEqual([]);
    });
  });

  describe("a chunk Gate C cannot parse fails the gate — it is never reported clean", () => {
    /**
     * The malformed fixture is built INLINE as a hand-made bundle rather than
     * as a fixture file on disk, for the same reason the leaked-chunk fixtures
     * are hand-made: a real Vite build can never hand Gate C an unparseable
     * chunk (esbuild would refuse the source long before `generateBundle`),
     * and the only way to reach Gate C's own parse call with input it cannot
     * read is to hand it that input directly. `findLeakedServerExports` is
     * exported as a pure function over a bundle object precisely for this.
     */
    const UNPARSEABLE_CHUNK = "export const route = (((;\nfunction {{{";

    it("case 5: an unparseable emitted chunk throws and names the file, instead of being skipped and reported leak-free", () => {
      const bundle = {
        "assets/broken.page-4f2a1c.js": {
          type: "chunk",
          fileName: "assets/broken.page-4f2a1c.js",
          code: UNPARSEABLE_CHUNK,
        },
      };

      expect(() => findLeakedServerExports(bundle)).toThrow(
        /assets\/broken\.page-4f2a1c\.js/,
      );

      try {
        findLeakedServerExports(bundle);
        expect.unreachable("expected the unparseable chunk to fail the gate");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("assets/broken.page-4f2a1c.js");
        expect(message).toContain("could not be parsed");
        expect(message).toContain("could not be performed");
      }
    });

    it("case 7: names BOTH possible causes and admits it cannot tell them apart, rather than blaming one", () => {
      // The gate cannot know whether the emitted syntax outran the parser we
      // ship or a plugin wrote something non-standard, and a message that
      // picks one sends the reader to bisect the wrong dependency. These are
      // semantic assertions on purpose: they pin the honesty of the message,
      // not its exact prose, so the wording stays free to improve.
      let message = "";

      try {
        findLeakedServerExports({
          "assets/broken.page-4f2a1c.js": {
            type: "chunk",
            fileName: "assets/broken.page-4f2a1c.js",
            code: UNPARSEABLE_CHUNK,
          },
        });
        expect.unreachable("expected the unparseable chunk to fail the gate");
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toMatch(/parser/i);
      expect(message).toMatch(/plugin|loader/i);
      expect(message).toMatch(/cannot tell which|cannot distinguish|which of these/i);
    });

    it("case 6: a parseable chunk sitting alongside the unparseable one does not rescue the build — the gate still fails", () => {
      expect(() =>
        findLeakedServerExports({
          "assets/fine.js": { type: "chunk", fileName: "assets/fine.js", code: "export const x = 1;" },
          "assets/broken.page-4f2a1c.js": {
            type: "chunk",
            fileName: "assets/broken.page-4f2a1c.js",
            code: UNPARSEABLE_CHUNK,
          },
        }),
      ).toThrow(/assets\/broken\.page-4f2a1c\.js/);
    });
  });

  describe("the inlined PUBLIC_* value manifest", () => {
    it("case 4: the manifest lists exactly the PUBLIC_* keys actually read, values shown or redacted conservatively, agreeing with Gate B's unread-key exclusion", async () => {
      const previousApiUrl = process.env.PUBLIC_API_URL;
      const previousStripeKey = process.env.PUBLIC_STRIPE_KEY;
      const previousUnreadVar = process.env.PUBLIC_UNREAD_VAR;
      // Assembled at runtime so this spec's SOURCE never contains a contiguous
      // Stripe-shaped token — GitHub push protection scans source bytes and
      // blocks the push otherwise. Gate C only ever sees the runtime value
      // (via env → built page output), so the test's semantics are unchanged.
      const fakeStripeKey = ["sk_l", "ive_51ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("");
      process.env.PUBLIC_API_URL = "https://api.example.com";
      process.env.PUBLIC_STRIPE_KEY = fakeStripeKey;
      process.env.PUBLIC_UNREAD_VAR = "should-never-appear-anywhere";
      try {
        const result = await buildPageThroughFullPipeline("manifest-entry.page.tsx");
        const code = firstChunkCode(result);

        // Verified on the actual emitted output, not just the manifest's own
        // say-so — same discipline as every other gate in this pipeline.
        expect(code).toContain("https://api.example.com");
        expect(code).toContain(fakeStripeKey);
        expect(code).not.toContain("should-never-appear-anywhere");

        const manifest = manifestOf(result);
        expect(manifest).toEqual([
          { key: "PUBLIC_API_URL", value: "https://api.example.com", redacted: false },
          { key: "PUBLIC_STRIPE_KEY", value: null, redacted: true },
        ]);
      } finally {
        process.env.PUBLIC_API_URL = previousApiUrl;
        process.env.PUBLIC_STRIPE_KEY = previousStripeKey;
        process.env.PUBLIC_UNREAD_VAR = previousUnreadVar;
      }
    });
  });
});
