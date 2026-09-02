import fs from "node:fs";
import { createServer as createNodeServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer as createViteServer } from "vite";
import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";
import {
  buildWarlockHydrationClient,
  warlockClientBoundary,
  type WarlockClientBoundaryOptions,
} from "./index";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_ROOT = path.join(
  __dirname,
  "..",
  "..",
  "__tests__",
  "vite",
  "fixtures",
  "composed",
);
const PAGE_DIR = path.join(FIXTURE_ROOT, "app", "blog", "web");
const WEB_ROOT = path.resolve(__dirname, "..", "..");

const GATE_A_FIXTURE_ROOT = path.join(
  __dirname,
  "..",
  "..",
  "__tests__",
  "vite",
  "fixtures",
  "gate-a",
);
const GATE_A_PAGE_DIR = path.join(GATE_A_FIXTURE_ROOT, "app", "blog", "web");

/**
 * Runs a real Vite build (JS API, not npx) through the COMPOSED
 * pipeline (`projection` + Gate A `resolveId`, in that order), for a single
 * fixture page — never the two plugins in isolation. Verifies the actual
 * emitted outcome, matching D.1/D.2's verification convention.
 */
async function buildPage(
  fileName: string,
  boundaryOptions: WarlockClientBoundaryOptions = {},
) {
  return build({
    root: FIXTURE_ROOT,
    logLevel: "silent",
    plugins: [
      warlockClientBoundary({ appRoot: FIXTURE_ROOT, ...boundaryOptions }),
    ],
    build: {
      write: false,
      minify: false,
      lib: {
        entry: path.join(PAGE_DIR, fileName),
        formats: ["es"],
        fileName: () => "out.js",
      },
      rollupOptions: {
        // Node builtins are refused by Gate A itself; nothing else should
        // externalize them out from under the gate.
        external: [],
      },
    },
  });
}

function firstChunkCode(result: Awaited<ReturnType<typeof buildPage>>): string {
  const output = Array.isArray(result) ? result[0] : result;
  const chunk = "output" in output ? output.output[0] : undefined;
  if (!chunk || chunk.type !== "chunk")
    throw new Error("expected a JS chunk in the build output");
  return chunk.code;
}

type ServedSsrResult = {
  status: number;
  body: string;
};

async function serveSsrSource(
  source: string,
  extraFiles: Readonly<Record<string, string>> = {},
): Promise<ServedSsrResult> {
  const appRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "warlock-dev-ssr-boundary-"),
  );
  const pagePath = path.join(appRoot, "src", "web", "probe.page.tsx");
  fs.mkdirSync(path.dirname(pagePath), { recursive: true });
  fs.writeFileSync(pagePath, source);

  for (const [relativePath, contents] of Object.entries(extraFiles)) {
    const target = path.join(appRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  const vite = await createViteServer({
    root: appRoot,
    appType: "custom",
    logLevel: "silent",
    plugins: [
      warlockClientBoundary({
        appRoot,
        serverPackages: ["@warlock.js/core"],
      }),
    ],
    server: { middlewareMode: true },
  });
  const server = createNodeServer(async (_request, response) => {
    try {
      const module = await vite.ssrLoadModule(pagePath);
      const body = String(module.default());
      response.statusCode = 200;
      response.end(body);
    } catch (error) {
      response.statusCode = 500;
      response.end((error as Error).message);
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected a TCP address for the SSR regression server");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    return { status: response.status, body: await response.text() };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await vite.close();
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
}

describe("warlockClientBoundary — composed projection + Gate A pipeline (real Vite builds)", () => {
  // `@warlock.js/core` carries no `warlock.environment` marker of its own, and
  // an ABSENT marker classifies as universal (see `createEnvironmentClassifier`
  // and `gate-a-resolve.spec.ts` case 6). Case 2 below is about PROJECTION —
  // that a component-level import is not stripped and still meets Gate A — not
  // about how core is classified, so it names core as server explicitly, the
  // same way `gate-a-resolve.spec.ts` case 1 does. Without this the build
  // wanders into core's own dependencies and fails on an unrelated rule, which
  // proves nothing about projection.
  const CORE_AS_SERVER: WarlockClientBoundaryOptions = {
    serverPackages: ["@warlock.js/core"],
  };

  it("case 1 (positive): loader-only @warlock.js/core import is stripped by projection before Gate A sees it, build succeeds", async () => {
    const result = await buildPage("case1-loader-only-core-import.page.tsx");
    const code = firstChunkCode(result);

    expect(code).not.toContain("@warlock.js/core");
    expect(code).not.toContain("loader");
    expect(code).toContain("blog page");
  });

  it("case 2 (negative control): a component-level @warlock.js/core import is never touched by projection and is still refused by Gate A", async () => {
    try {
      await buildPage("case2-component-core-import.page.tsx", CORE_AS_SERVER);
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(
        "Import chain: case2-component-core-import.page.tsx → @warlock.js/core",
      );
      expect(message).toContain("Cause:");
      expect(message).toContain("server-only @warlock.js package");
      expect(message).toContain("Fix:");
    }
  });

  it("case 3 (Gate B): an inline process.env read inside the page component survives projection and is refused by Gate B", async () => {
    try {
      await buildPage("case3-inline-secret.page.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Gate B refused a module");
      expect(message).toContain("case3-inline-secret.page.tsx:");
      expect(message).toContain("Expression: process.env.SECRET_KEY");
      expect(message).toContain("Cause:");
      expect(message).toContain("Fix:");
    }
  });
});

describe("warlockClientBoundary - development SSR projected-client gate", () => {
  const secret = "SSR_SECRET_MUST_NOT_REACH_HTML_91d2";

  const forbiddenSources = [
    {
      name: 'env("APP_SECRET")',
      source: `import { env } from "@warlock.js/core";\nexport default function Page() { return env("APP_SECRET"); }\n`,
      gate: "Gate A",
    },
    {
      name: "process.env.PUBLIC_SITE_NAME",
      source: `export default function Page() { return process.env.PUBLIC_SITE_NAME; }\n`,
      gate: "Gate B",
    },
    {
      name: "process.env.APP_SECRET",
      source: `export default function Page() { return process.env.APP_SECRET; }\n`,
      gate: "Gate B",
    },
    {
      name: "process.env[key]",
      source: `const key = "APP_SECRET";\nexport default function Page() { return process.env[key]; }\n`,
      gate: "Gate B",
    },
    {
      name: "destructured process.env",
      source: `export default function Page() { const { APP_SECRET } = process.env; return APP_SECRET; }\n`,
      gate: "Gate B",
    },
    {
      name: "JSON.stringify(process.env)",
      source: `export default function Page() { return JSON.stringify(process.env); }\n`,
      gate: "Gate B",
    },
  ] as const;

  for (const fixture of forbiddenSources) {
    it(`returns HTTP 500 without the secret for ${fixture.name}`, async () => {
      const previousSecret = process.env.APP_SECRET;
      const previousPublic = process.env.PUBLIC_SITE_NAME;
      process.env.APP_SECRET = secret;
      process.env.PUBLIC_SITE_NAME = secret;

      try {
        const response = await serveSsrSource(fixture.source);

        expect(response.status).toBe(500);
        expect(response.body).toContain(`${fixture.gate} refused`);
        expect(response.body).not.toContain(secret);
      } finally {
        if (previousSecret === undefined) delete process.env.APP_SECRET;
        else process.env.APP_SECRET = previousSecret;
        if (previousPublic === undefined) delete process.env.PUBLIC_SITE_NAME;
        else process.env.PUBLIC_SITE_NAME = previousPublic;
      }
    });
  }

  it("checks a component-reachable helper outside web/ as part of the client graph", async () => {
    const previousSecret = process.env.APP_SECRET;
    process.env.APP_SECRET = secret;

    try {
      const response = await serveSsrSource(
        `import { secret } from "../shared";\nexport default function Page() { return secret(); }\n`,
        {
          "src/shared.ts":
            "export function secret() { return process.env.APP_SECRET; }\n",
        },
      );

      expect(response.status).toBe(500);
      expect(response.body).toContain("Gate B refused");
      expect(response.body).toContain("shared.ts");
      expect(response.body).not.toContain(secret);
    } finally {
      if (previousSecret === undefined) delete process.env.APP_SECRET;
      else process.env.APP_SECRET = previousSecret;
    }
  });

  it("leaves a page CSS import in Vite's normal SSR pipeline", async () => {
    const response = await serveSsrSource(
      `import "./probe.css";\nexport default function Page() { return "styled component"; }\n`,
      { "src/web/probe.css": ".probe { color: rebeccapurple; }\n" },
    );

    expect(response).toEqual({ status: 200, body: "styled component" });
  });

  it("does not inspect a loader-only env read removed from the projected client view", async () => {
    const previousSecret = process.env.APP_SECRET;
    process.env.APP_SECRET = secret;

    try {
      const response = await serveSsrSource(
        `export async function loader() { return process.env.APP_SECRET; }\nexport default function Page() { return "safe component"; }\n`,
      );

      expect(response).toEqual({ status: 200, body: "safe component" });
    } finally {
      if (previousSecret === undefined) delete process.env.APP_SECRET;
      else process.env.APP_SECRET = previousSecret;
    }
  });

  it("leaves an explicitly server-only SSR entry unrestricted", async () => {
    const appRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "warlock-dev-ssr-server-only-"),
    );
    const serverFile = path.join(appRoot, "src", "server", "secret.server.ts");
    fs.mkdirSync(path.dirname(serverFile), { recursive: true });
    fs.writeFileSync(
      serverFile,
      `export default function readSecret() { return process.env.APP_SECRET; }\n`,
    );
    const previousSecret = process.env.APP_SECRET;
    process.env.APP_SECRET = secret;
    const vite = await createViteServer({
      root: appRoot,
      appType: "custom",
      logLevel: "silent",
      plugins: [warlockClientBoundary({ appRoot })],
      server: { middlewareMode: true },
    });

    try {
      const module = await vite.ssrLoadModule(serverFile);
      expect(module.default()).toBe(secret);
    } finally {
      await vite.close();
      fs.rmSync(appRoot, { recursive: true, force: true });
      if (previousSecret === undefined) delete process.env.APP_SECRET;
      else process.env.APP_SECRET = previousSecret;
    }
  });
});

describe("buildWarlockHydrationClient — configured plugin parity", () => {
  it("runs a Tailwind-style Vite plugin after Warlock's boundary and emits its CSS asset", async () => {
    const outDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "warlock-vite-plugin-build-"),
    );
    const tailwindStylePlugin: Plugin = {
      name: "tailwindcss-vite-style",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "assets/tailwind-generated.css",
          source: ".generated-by-tailwind-style{display:block}",
        });
      },
    };

    try {
      const result = await buildWarlockHydrationClient({
        appRoot: FIXTURE_ROOT,
        webRoot: WEB_ROOT,
        outDir,
        resolveAliases: [{ find: "web", replacement: WEB_ROOT }],
        plugins: [tailwindStylePlugin],
      });
      const outputs = Array.isArray(result.output)
        ? result.output
        : [result.output];
      const asset = outputs
        .flatMap((output) => output.output)
        .find(
          (file) =>
            file.type === "asset" &&
            file.fileName === "assets/tailwind-generated.css",
        );

      expect(asset?.type).toBe("asset");
      expect(asset && "source" in asset ? asset.source : undefined).toContain(
        ".generated-by-tailwind-style",
      );
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("hook ordering pin — transform runs before resolveId", () => {
  it("records transform(entry) firing before resolveId of the entry's own surviving import specifier, via a real vite.build()", async () => {
    // Instrumented real build (not asserted from plugin array order — see
    // the ordering-dependent comment above `warlockClientBoundary` in
    // `index.ts`). Pins the exact fact D.3 discovered: for a given module,
    // Rollup must parse its post-transform source before it can even
    // discover which import specifiers to resolve next, so `transform`
    // necessarily fires before `resolveId` for that module's own imports.
    // If a future Vite/Rollup upgrade inverts this, this test fails loudly
    // — see the comment above `warlockClientBoundary` for why that failure
    // mode is safe and must not be "fixed" by weakening Gate A instead.
    const entryFile = "case3-universal-pass.page.tsx";
    const events: string[] = [];
    const recorder: Plugin = {
      name: "test:hook-order-recorder",
      // `enforce: "pre"` for the same reason Gate A itself needs it (see
      // `gate-a-resolve.ts`): Vite's own core resolver would otherwise
      // resolve "./helper" before this plugin's `resolveId` runs at all.
      enforce: "pre",
      transform(_code, id) {
        if (id.endsWith(entryFile))
          events.push(`transform:${path.basename(id)}`);
        return null;
      },
      resolveId(source, importer) {
        if (source === "./helper" && importer?.endsWith(entryFile)) {
          events.push(`resolveId:${source}`);
        }
        return null;
      },
    };

    await build({
      root: GATE_A_FIXTURE_ROOT,
      logLevel: "silent",
      plugins: [recorder],
      build: {
        write: false,
        minify: false,
        lib: {
          entry: path.join(GATE_A_PAGE_DIR, entryFile),
          formats: ["es"],
          fileName: () => "out.js",
        },
      },
    });

    const transformIndex = events.indexOf(`transform:${entryFile}`);
    const resolveIdIndex = events.indexOf("resolveId:./helper");

    expect(transformIndex).toBeGreaterThanOrEqual(0);
    expect(resolveIdIndex).toBeGreaterThanOrEqual(0);
    expect(transformIndex).toBeLessThan(resolveIdIndex);
  });
});
