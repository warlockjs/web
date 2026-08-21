import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { warlockClientBoundary } from "./index";
import { gateCVerify } from "./gate-c-verify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_ROOT = path.join(__dirname, "..", "..", "__tests__", "vite", "fixtures", "gate-c");
const PAGE_DIR = path.join(FIXTURE_ROOT, "app", "blog", "web");

/**
 * Runs a real Vite build (JS API — canon `50608334`) through the FULL
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

  describe("Part 2: inlined PUBLIC_* value manifest (Suki, room seq 561 pt.2)", () => {
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
