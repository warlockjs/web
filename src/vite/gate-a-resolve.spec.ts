import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Alias, type Plugin, type Rollup } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gateAResolve, type EnvironmentClassifierOptions as GateAOptions } from "./gate-a-resolve";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Gate A prints POSIX-separated paths; the fixture paths here are built with `path.join`. */
const normalizeSlashes = (value: string) => value.replace(/\\/g, "/");

/**
 * Generated rather than committed, for the reason case 21 gives: these files
 * only exist to be resolved, and a committed tree of stubs invites the next
 * reader to wonder which rule each one is for. Shared by the extension suite
 * and the spelling-equivalence suite below.
 */
function writeFixture(file: string, contents: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

const FIXTURE_ROOT = path.join(__dirname, "..", "..", "__tests__", "vite", "fixtures", "gate-a");
const PAGE_DIR = path.join(FIXTURE_ROOT, "app", "blog", "web");
const SEAL_SRC_DIR = path.join(__dirname, "..", "..", "..", "seal", "src");
const SEAL_SRC = path.join(SEAL_SRC_DIR, "index.ts");
/**
 * A governed-scope package whose internals live under `web/src/server/` —
 * the shape `@warlock.js/web` itself has — parked OUTSIDE `FIXTURE_ROOT` so
 * it is reached the way a monorepo sibling is, not through node_modules.
 */
const SIBLING_PKG_DIR = path.join(
  __dirname,
  "..",
  "..",
  "__tests__",
  "vite",
  "fixtures",
  "gate-a-sibling-pkg",
);
const SIBLING_PKG_ENTRY = path.join(SIBLING_PKG_DIR, "web", "src", "server", "runtime.ts");

/**
 * Runs a real Vite build (JS API, not npx) for a single
 * fixture page, with Gate A as the only plugin. Verifies the actual emitted
 * resolution outcome, never the plugin logic in isolation.
 */
async function buildPage(fileName: string, gateOptions: GateAOptions = {}) {
  return buildEntry(path.join(PAGE_DIR, fileName), gateOptions);
}

/**
 * The same real build, entered at an ARBITRARY absolute path rather than at a
 * page under `app/blog/web/`.
 *
 * Every case above enters through a page, which is the common shape but not the
 * only surface Gate A judges — the app root lives at `src/web/root.tsx` and is
 * reachable from no page directory. Parameterising the entry is what lets a
 * root file be built at all.
 */
async function buildEntry(entry: string, gateOptions: GateAOptions = {}, harness: BuildHarness = {}) {
  return build({
    root: FIXTURE_ROOT,
    logLevel: "silent",
    resolve: {
      alias: [
        ...(harness.aliases ?? []),
        { find: /^@warlock\.js\/seal$/, replacement: SEAL_SRC },
        { find: /^@warlock\.js\/seal\//, replacement: `${SEAL_SRC_DIR}/` },
        { find: /^@warlock\.js\/sibling-web$/, replacement: SIBLING_PKG_ENTRY },
      ],
    },
    plugins: [gateAResolve({ appRoot: FIXTURE_ROOT, ...gateOptions }), ...(harness.plugins ?? [])],
    build: {
      write: false,
      minify: false,
      lib: {
        entry,
        formats: ["es"],
        fileName: () => "out.js",
      },
      rollupOptions: {
        // Node builtins are refused by Gate A itself; nothing else should
        // externalize them out from under the gate.
        external: [],
        ...(harness.onwarn ? { onwarn: harness.onwarn } : {}),
      },
    },
  });
}

/**
 * The three knobs the spelling-equivalence suite needs and no case above does.
 *
 * `aliases` — an app-convention alias table, prepended to the fixture's own.
 * The v5 app's DEV server installs `app/*` and `web/*`; its production client
 * build installs nothing, and the difference is the whole finding, so the
 * suite has to be able to build BOTH configurations.
 *
 * `plugins` — appended AFTER Gate A (which is `enforce: "pre"`), so a resolver
 * placed here is reached by Gate A's own `this.resolve` rather than pre-empting
 * it. That ordering is what lets the suite model a `vite-tsconfig-paths`-shaped
 * resolver: one that answers a bare specifier with a final absolute id.
 *
 * `onwarn` — the warning sink. Gate A reports an alias-form violation through
 * `this.warn`, and a Rollup build that emits one still SUCCEEDS, so a suite
 * that only catches throws cannot see it at all.
 */
interface BuildHarness {
  aliases?: Alias[];
  plugins?: Plugin[];
  onwarn?: Rollup.WarningHandlerWithDefault;
}

/**
 * The type-only fixture root. Separate from `FIXTURE_ROOT` for one reason that
 * is the whole point of the suite below: it carries its OWN `tsconfig.json`
 * with `verbatimModuleSyntax: true`, which is what makes
 * `import { type X } from "P"` survive esbuild as `import {} from "P"` and
 * therefore reach Gate A at all. It also vendors a tiny
 * `node_modules/@warlock.js/core` stub, so the permitted cases can really
 * resolve and load (the real core reaches Node builtins and would be refused
 * by rule 1 before rule 2 was ever the thing under test).
 */
const TYPE_ONLY_ROOT = path.join(
  __dirname,
  "..",
  "..",
  "__tests__",
  "vite",
  "fixtures",
  "gate-a-typeonly",
);
const TYPE_ONLY_PAGE_DIR = path.join(TYPE_ONLY_ROOT, "app", "blog", "web");

async function buildTypeOnlyPage(fileName: string, gateOptions: GateAOptions = {}) {
  return build({
    root: TYPE_ONLY_ROOT,
    logLevel: "silent",
    plugins: [gateAResolve({ appRoot: TYPE_ONLY_ROOT, ...gateOptions })],
    build: {
      write: false,
      minify: false,
      lib: {
        entry: path.join(TYPE_ONLY_PAGE_DIR, fileName),
        formats: ["es"],
        fileName: () => "out.js",
      },
      rollupOptions: { external: [] },
    },
  });
}

function firstChunkCode(result: Awaited<ReturnType<typeof buildPage>>): string {
  const output = Array.isArray(result) ? result[0] : result;
  const chunk = "output" in output ? output.output[0] : undefined;
  if (!chunk || chunk.type !== "chunk") throw new Error("expected a JS chunk in the build output");
  return chunk.code;
}

describe("gateAResolve — Gate A resolveId refusal (real Vite builds)", () => {
  // `@warlock.js/core` now declares `"warlock": { "environment": "server" }` in
  // its own package.json (2026-08-24), so this case passes NO options at all.
  //
  // It used to pass `serverPackages: ["@warlock.js/core"]` — a stand-in for a
  // marker that did not exist, which meant the test described a world that was
  // not true. Removing the stand-in is the proof that the REAL marker does the
  // work the fake was doing. Do not reintroduce it: if this case ever needs the
  // option again, core's marker has been lost.
  const CORE_AS_SERVER: GateAOptions = { serverPackages: ["@warlock.js/core"] };

  it("case 1: a page importing a server-classified @warlock.js/core service directly fails, chain printed", async () => {
    await expect(buildPage("case1-core-import.page.tsx")).rejects.toThrow();

    try {
      await buildPage("case1-core-import.page.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Import chain: case1-core-import.page.tsx → @warlock.js/core");
      expect(message).toContain("Cause:");
      expect(message).toContain("@warlock.js/core");
      expect(message).toContain("server-only @warlock.js package");
      expect(message).toContain("Fix:");
      expect(message).toContain("File:");
    }
  });

  it("case 2: a page importing a sibling .server.ts file directly fails", async () => {
    try {
      await buildPage("case2-server-sibling.page.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Import chain: case2-server-sibling.page.tsx → ./case2.server");
      expect(message).toContain("Cause:");
      expect(message).toContain("server-only file");
      expect(message).toContain("Fix:");
    }
  });

  it("case 3: a page importing a sibling universal helper passes", async () => {
    const result = await buildPage("case3-universal-pass.page.tsx");
    const code = firstChunkCode(result);
    expect(code).toContain("formatTitle");
  });

  it("case 4: a page importing @warlock.js/seal for a schema passes (seal is universal)", async () => {
    const result = await buildPage("case4-seal-import.page.tsx");
    const code = firstChunkCode(result);
    expect(code).toContain("anySchema");
  });

  it("case 5: a page importing node:fs transitively (2-hop) fails, chain shows both hops", async () => {
    try {
      await buildPage("case5-fs-chain.page.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(
        "Import chain: case5-fs-chain.page.tsx → fs-helper.ts → node:fs",
      );
      expect(message).toContain("Cause:");
      expect(message).toContain("Node.js builtin module");
      expect(message).toContain("Fix:");
    }
  });

  it("case 6: a governed-scope package with NO warlock marker is allowed (fail-open default)", async () => {
    const result = await buildPage("case6-unmarked-governed.page.tsx");
    const code = firstChunkCode(result);
    expect(code).toContain("unmarked-pkg-value");
  });

  it("case 7: a governed-scope package declaring environment: server is still refused", async () => {
    try {
      await buildPage("case7-marked-server-pkg.page.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(
        "Import chain: case7-marked-server-pkg.page.tsx → @warlock.js/marked-server-pkg",
      );
      expect(message).toContain("server-only @warlock.js package");
      expect(message).toContain('"warlock": { "environment": "server" }');
      expect(message).toContain("Fix:");
    }
  });

  it("case 8: a module importing \"server-only\", reached from a client entry, is refused with the chain", async () => {
    try {
      await buildPage("case8-server-only.page.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(
        "Import chain: case8-server-only.page.tsx → case8-helper.ts → server-only",
      );
      expect(message).toContain("Cause:");
      expect(message).toContain('imports "server-only"');
      expect(message).toContain("Fix:");
    }
  });

  // INVERTED 2026-08-24. This case used to assert that rule 4 refused a local
  // module for living outside `$module/web/`. That rule is gone (owner ruling,
  // canon `10f6041c`) and this case now asserts the opposite, because the
  // opposite is the point: `outside-helper.ts` imports NOTHING, and refusing it
  // for its address was a false positive that forced app structure to serve the
  // fence.
  //
  // The real-app instances this stands for are `app/access/permissions.ts`
  // (zero imports, name constants both sides need) and
  // `app/auth/schema/login.schema.ts` (imports only the universal seal package).
  // Both were refused for their address and neither is server-side.
  //
  // The fence did not get weaker: cases 10-13 still refuse `server/` folders,
  // case 2 still refuses `*.server.ts`, case 1 still refuses a package marked
  // server, and case 5 still refuses a Node builtin reached at any depth.
  it("case 9: a local module OUTSIDE $module/web/ that reaches nothing server-only is allowed", async () => {
    const result = await buildPage("case9-outside-web.page.tsx");
    expect(firstChunkCode(result)).toContain("outside");
  });

  it("case 10: a page importing into a server/ folder under the app source is refused with the chain", async () => {
    try {
      await buildPage("case10-server-folder.page.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(
        "Import chain: case10-server-folder.page.tsx → ./server/repo",
      );
      expect(message).toContain("Cause:");
      expect(message).toContain("server-only file");
      expect(message).toContain("server/ folder");
      expect(message).toContain("Fix:");
    }
  });

  it("case 11: a server/ folder anywhere under the app source counts, not only under web/", async () => {
    try {
      await buildPage("case11-app-server-folder.page.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(
        "Import chain: case11-app-server-folder.page.tsx → ../../users/server/repo",
      );
      expect(message).toContain("server-only file");
      expect(message).toContain("Fix:");
    }
  });

  // Cases 12 and 13 are the ones protecting the build. `@warlock.js/web` keeps
  // its own sources under `web/src/server/`; if the folder rule judged
  // dependency internals, every app importing the framework would be refused.
  it("case 12: a governed dependency's OWN src/server/ internals are NOT refused", async () => {
    const result = await buildPage("case12-dep-server-dir.page.tsx");
    const code = firstChunkCode(result);
    expect(code).toContain("framework-internal-value");
  });

  it("case 13: a workspace sibling's web/src/server/ internals are NOT refused", async () => {
    const result = await buildPage("case13-sibling-server-dir.page.tsx");
    const code = firstChunkCode(result);
    expect(code).toContain("sibling-server-value");
  });

  /**
   * THE APP ROOT — the surface every one of the 13 cases above skips.
   *
   * Gate A once carried a branch matching this exact path shape
   * (`isRecognizedUniversalSurface`: `normalized.endsWith("/src/web/App.tsx")`
   * — quoted as it was written, before the rename), and nothing had ever built
   * a root file through the gate, so the branch had no test at all. It was picked up as part of the `App.tsx` →
   * `root.tsx` fence, on the assumption that a rename which missed it would
   * make the root un-buildable.
   *
   * Building it says otherwise, and the control case below says why: the root
   * is admitted by the `web/` FOLDER rule, which returns first, and the
   * name-matching branch is never reached. Deleting that branch leaves both
   * cases green — measured by mutation, not inferred. It is dead code, and it
   * is therefore NOT part of the `root.tsx` rename fence.
   *
   * These two cases stay because the PROPERTY is worth pinning whichever rule
   * grants it: the app root must build through Gate A, and it must keep its
   * universal import while doing so.
   */
  it("case 14: the app root builds through Gate A and keeps its universal import", async () => {
    const result = await buildEntry(path.join(FIXTURE_ROOT, "src", "web", "root.tsx"));
    const code = firstChunkCode(result);
    expect(code).toContain("Warlock");
  });

  it("case 14b (control): an ORDINARY file beside the root builds too — the folder rule is what admits both", async () => {
    /*
      The discriminator. If Gate A admitted the root because of its NAME, a file
      one level inside `src/web/` with no special name would be refused. It
      builds, so the name branch is not what is doing the work — which is the
      evidence that turned "load-bearing site" into "dead code" on the rename
      fence.
    */
    const result = await buildEntry(
      path.join(FIXTURE_ROOT, "src", "web", "ordinary-web-file.tsx"),
    );
    const code = firstChunkCode(result);
    expect(code).toContain("ordinary");
  });
});

/**
 * RULE 1 — NODE BUILTINS, GENERICALLY AND WITHOUT REGARD TO SCOPE.
 *
 * Two properties are pinned here, and neither is implied by the fourteen cases
 * above (case 5 is the only builtin case among them, and it is a two-hop chain
 * inside the app's own source, written with one spelling of one builtin).
 *
 *   - GENERIC. The refused set is Node's own `builtinModules`, asked of the
 *     runtime, not a list living in `gate-a-resolve.ts`. A deny-list is correct
 *     until the next builtin ships and then silently wrong; `node:sqlite` and
 *     `node:test` are both recent enough to have missed any list this repo
 *     could have written. The generic case below proves the negative directly:
 *     it samples builtins whose names appear NOWHERE in the plugin's source
 *     text and shows them refused anyway.
 *
 *   - SCOPE-FREE. Rule 2's `GOVERNED_SCOPES` narrowing (`@warlock.js/`,
 *     `@mongez/`) is deliberately NOT inherited here. That narrowing is right
 *     for the environment MARKER — we do not get to declare whether Radix or
 *     Mantine is server-side — but a Node builtin in a browser bundle is wrong
 *     whoever imported it. Cases 17, 18 and 20 reach one through an ungoverned
 *     third-party package, which is the shape the app author cannot see from
 *     their own source at all.
 *
 * Case 19 is the control that keeps this from being a blanket suspicion of
 * node_modules, and the external-config pair at the end covers the one route a
 * builtin can take into a chunk without ever being offered to `resolveId`.
 */
describe("gateAResolve — rule 1 is generic and scope-free", () => {
  it("case 15: the app's own source importing a builtin by its BARE name is refused", async () => {
    try {
      await buildPage("case15-bare-builtin.page.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Import chain: case15-bare-builtin.page.tsx → fs");
      expect(message).toContain('"fs" is a Node.js builtin module');
      // The file, named in full, and the specifier. A fence that refuses
      // without saying what or where teaches people to switch it off.
      expect(message).toContain("case15-bare-builtin.page.tsx");
      expect(message).toContain("Fix:");
    }
  });

  it("case 16: the same builtin in its node: spelling, imported directly, is refused identically", async () => {
    try {
      await buildPage("case16-prefixed-builtin.page.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Import chain: case16-prefixed-builtin.page.tsx → node:fs");
      expect(message).toContain('"node:fs" is a Node.js builtin module');
      expect(message).toContain("case16-prefixed-builtin.page.tsx");
    }
  });

  /*
    Cases 17/18/20 are the ones the scope carve-out would have missed. The
    importer is a package in node_modules under no governed scope, and the app's
    own source never writes the builtin's name — `File:` naming the vendor file
    is the whole value of the refusal here, because that path is the only thing
    telling the author which dependency to replace.
  */
  it("case 17: a builtin reached TRANSITIVELY through an ungoverned third-party package is refused", async () => {
    try {
      await buildPage("case17-vendor-transitive.page.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(
        "Import chain: case17-vendor-transitive.page.tsx → vendor-node-lib/index.js → node:fs",
      );
      expect(message).toContain('"node:fs" is a Node.js builtin module');
      expect(message).toContain(`File: ${normalizeSlashes(path.join(FIXTURE_ROOT, "node_modules", "vendor-node-lib", "index.js"))}`);
    }
  });

  it("case 18: the same third-party shape with the bare builtin spelling is refused", async () => {
    try {
      await buildPage("case18-vendor-bare-transitive.page.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(
        "Import chain: case18-vendor-bare-transitive.page.tsx → vendor-bare-node-lib/index.js → crypto",
      );
      expect(message).toContain('"crypto" is a Node.js builtin module');
      expect(message).toContain("vendor-bare-node-lib");
    }
  });

  it("case 19 (NEGATIVE CONTROL): an ungoverned third-party package touching no builtin still builds", async () => {
    const result = await buildPage("case19-vendor-browser-safe.page.tsx");
    expect(firstChunkCode(result)).toContain("vendor-browser-value");
  });

  it("case 20: a CommonJS vendor reaching a builtin through require() is refused too", async () => {
    try {
      await buildPage("case20-vendor-cjs-transitive.page.tsx");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(
        "Import chain: case20-vendor-cjs-transitive.page.tsx → vendor-cjs-node-lib/index.js → os",
      );
      expect(message).toContain('"os" is a Node.js builtin module');
    }
  });

  /**
   * THE GENERIC CASE.
   *
   * Sampled from `builtinModules` at runtime and filtered down to the names
   * that appear NOWHERE in `gate-a-resolve.ts`'s source text. That filter is
   * what makes this a proof rather than a demonstration: the plugin cannot be
   * matching these by name, because it does not contain them. `includes` is a
   * substring test, so short names that happen to occur inside an unrelated
   * word are excluded too — which only shrinks the candidate pool, never
   * weakens the claim.
   *
   * Fixture files are GENERATED rather than committed for the same reason: a
   * committed fixture would be a hand-written list wearing a different hat, and
   * would pin whichever builtins were current the day it was written.
   */
  const PLUGIN_SOURCE = readFileSync(path.join(__dirname, "gate-a-resolve.ts"), "utf-8");
  const UNNAMED_BUILTINS = builtinModules.filter(
    (name) => !name.startsWith("_") && !name.startsWith("node:") && !PLUGIN_SOURCE.includes(name),
  );
  /** A spread across Node's list, not its first few entries. */
  const SAMPLE_SIZE = 6;
  const SAMPLED_BUILTINS = Array.from({ length: SAMPLE_SIZE }, (_, index) => {
    return UNNAMED_BUILTINS[Math.floor((index * UNNAMED_BUILTINS.length) / SAMPLE_SIZE)];
  });

  const GENERATED_DIR = path.join(PAGE_DIR, "generated");

  afterAll(() => {
    rmSync(GENERATED_DIR, { recursive: true, force: true });
  });

  /**
   * Writes a throwaway entry importing `specifier` and builds it. Named
   * `*.page.tsx` so rule 4 admits it as a recognized universal surface whatever
   * else is true of its location — this suite must fail on rule 1 or not at
   * all. (It sits one level below the module's `web/` folder, which since the
   * rule-4 depth fix admits it by folder as well; the name is what makes that
   * independent of the folder rule.)
   */
  async function buildGeneratedImportOf(specifier: string) {
    mkdirSync(GENERATED_DIR, { recursive: true });
    const fileName = `${specifier.replace(/[^a-z0-9]+/gi, "-")}.page.tsx`;
    const file = path.join(GENERATED_DIR, fileName);
    writeFileSync(file, `import "${specifier}";\n\nexport default function Page() {\n  return "generated";\n}\n`);
    return buildEntry(file);
  }

  it(`case 21 (GENERIC): builtins this file never names — ${SAMPLED_BUILTINS.join(", ")} — are refused in both spellings`, async () => {
    // If this ever empties out, the plugin has started enumerating builtins and
    // the whole point of the case has quietly evaporated.
    expect(UNNAMED_BUILTINS.length).toBeGreaterThan(20);

    for (const name of SAMPLED_BUILTINS) {
      for (const specifier of [name, `node:${name}`]) {
        await expect(
          buildGeneratedImportOf(specifier),
          `expected "${specifier}" to be refused`,
        ).rejects.toThrow(`"${specifier}" is a Node.js builtin module`);
      }
    }
  });

  it("case 22 (GENERIC): a node:-prefixed specifier is refused by SHAPE, even when builtinModules has never heard of it", async () => {
    // The prefix is reserved by Node for builtins; nothing else can claim it.
    // This is what covers builtins that ship after this Node version — and the
    // prefix-only ones (`node:test`, `node:sqlite`) on runtimes whose
    // `builtinModules` omits them.
    expect(builtinModules).not.toContain("not-a-real-builtin-yet");
    await expect(buildGeneratedImportOf("node:not-a-real-builtin-yet")).rejects.toThrow(
      '"node:not-a-real-builtin-yet" is a Node.js builtin module',
    );
  });

  /**
   * THE CONFIG-LEVEL HALF.
   *
   * Rollup consults `external` BEFORE any `resolveId` hook, so an externalized
   * builtin is never offered to Gate A at all. Measured on this exact fixture
   * before the guard existed: the build succeeded and the emitted chunk still
   * opened with `import { readFileSync } from "node:fs"`. `buildStart` is the
   * only place left to catch it.
   */
  async function buildWithExternal(fileName: string, external: string[]) {
    return build({
      root: FIXTURE_ROOT,
      logLevel: "silent",
      plugins: [gateAResolve({ appRoot: FIXTURE_ROOT })],
      build: {
        write: false,
        minify: false,
        lib: { entry: path.join(PAGE_DIR, fileName), formats: ["es"], fileName: () => "out.js" },
        rollupOptions: { external },
      },
    });
  }

  it("case 23: a build whose rollup external list carries a builtin is refused before any module loads", async () => {
    try {
      await buildWithExternal("case16-prefixed-builtin.page.tsx", ["node:fs", "fs"]);
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Gate A refused this build");
      expect(message).toContain("Externalized builtins:");
      expect(message).toContain("node:fs");
      expect(message).toContain("Fix:");
    }
  });

  it("case 24 (NEGATIVE CONTROL): externalizing an ORDINARY package is untouched by that guard", async () => {
    const result = await buildWithExternal("case19-vendor-browser-safe.page.tsx", ["vendor-browser-lib"]);
    expect(firstChunkCode(result as never)).toContain("vendor-browser-lib");
  });
});

/**
 * RULE 2 AND TYPE-ONLY IMPORTS.
 *
 * `resolveId` gets a specifier string and an importer path — no AST — so rule 2
 * cannot see for itself that an import carried no value binding. Under
 * `verbatimModuleSyntax: true` (set in BOTH `v5/app/tsconfig.json` and
 * `web/tsconfig.json`) esbuild emits `import { type X } from "P"` verbatim as
 * `import {} from "P"`, so the specifier DOES reach the gate, and refusing it
 * would be a false positive on an import that binds nothing. Measured, not
 * assumed: a spy `resolveId` over this exact fixture sees `"@warlock.js/core"`
 * for case A, and case A is refused by this very gate the moment the plugin's
 * `transform` hook is taken away.
 *
 * The fix reads the import kind in `transform`, off the PRE-esbuild source, and
 * hands the answer forward to `resolveId`. Two things are being pinned here and
 * they are not the same thing:
 *
 *   - cases A/B: the false positive is gone, AND the server package's
 *     module-level code does not reach the chunk. That second half is not
 *     decoration. Measured on this exact fixture: simply PERMITTING the import
 *     puts `core-module-side-effect-ran` in the emitted output, because Rollup
 *     honours `import {} from "P"` as a side-effect edge. "Type-only" erases
 *     the BINDINGS, never the module edge — so the edge is erased deliberately,
 *     to an empty module, instead of being let through.
 *   - cases C-F: the carve-out is SCOPED, not a disabled rule. Every way of
 *     spelling a real runtime edge still fails.
 */
describe("gateAResolve — rule 2 and type-only imports (verbatimModuleSyntax fixture)", () => {
  const CORE_AS_SERVER: GateAOptions = { serverPackages: ["@warlock.js/core"] };

  /** The stub core's module-level side effect — present iff core reached the chunk. */
  const CORE_SIDE_EFFECT = "core-module-side-effect-ran";

  it("case A: `import { type X }` from a server-marked package builds CLEAN and drags nothing in", async () => {
    const result = await buildTypeOnlyPage("inline-type-only.page.tsx", CORE_AS_SERVER);
    const code = firstChunkCode(result);
    expect(code).toContain("inline-type-only-page");
    expect(code).not.toContain(CORE_SIDE_EFFECT);
    expect(code).not.toContain("core-value-binding");
  });

  /*
    Case B passes for a DIFFERENT reason than case A, and the difference is
    worth stating rather than hiding behind a green tick. Measured on this
    fixture with a spy `resolveId`: the inline form of case A reaches Gate A
    (`resolveId` saw "@warlock.js/core"), the STATEMENT form below does not
    (`resolveId` saw nothing) — esbuild deletes `import type { … }` outright
    even under `verbatimModuleSyntax`, which is why `v5/app` is safe today and
    `v5/example-app` would not be. So case B is not a second test of the
    carve-out; it is the pin that says this form must never START reaching the
    gate. If a future esbuild preserves it, case B keeps passing only because
    the carve-out catches it — which is the correct outcome either way.
  */
  it("case B: `import type { X }` — the statement spelling — is also clean", async () => {
    const result = await buildTypeOnlyPage("statement-type-only.page.tsx", CORE_AS_SERVER);
    const code = firstChunkCode(result);
    expect(code).toContain("statement-type-only-page");
    expect(code).not.toContain(CORE_SIDE_EFFECT);
  });

  it("case C (NEGATIVE CONTROL): the same page with a real VALUE import still FAILS", async () => {
    try {
      await buildTypeOnlyPage("value-import.page.tsx", CORE_AS_SERVER);
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Gate A refused an import");
      expect(message).toContain("Import chain: value-import.page.tsx → @warlock.js/core");
      expect(message).toContain("server-only @warlock.js package");
    }
  });

  it("case D (NEGATIVE CONTROL): a type-only import beside a value import of the same package FAILS", async () => {
    try {
      await buildTypeOnlyPage("mixed-import.page.tsx", CORE_AS_SERVER);
      expect.unreachable("expected the build to fail");
    } catch (error) {
      expect((error as Error).message).toContain("server-only @warlock.js package");
    }
  });

  it("case E (NEGATIVE CONTROL): a bare side-effect `import \"P\"` FAILS — it is not an erased type import", async () => {
    try {
      await buildTypeOnlyPage("bare-side-effect.page.tsx", CORE_AS_SERVER);
      expect.unreachable("expected the build to fail");
    } catch (error) {
      expect((error as Error).message).toContain("server-only @warlock.js package");
    }
  });

  it("case F (NEGATIVE CONTROL): a dynamic import beside a type-only static import FAILS", async () => {
    try {
      await buildTypeOnlyPage("dynamic-import.page.tsx", CORE_AS_SERVER);
      expect.unreachable("expected the build to fail");
    } catch (error) {
      expect((error as Error).message).toContain("server-only @warlock.js package");
    }
  });

  it("case G: rule 3 still refuses a type-only import of a *.server file — the carve-out is rule 2 only", async () => {
    try {
      await buildTypeOnlyPage("type-only-server-file.page.tsx", CORE_AS_SERVER);
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Import chain: type-only-server-file.page.tsx → ./repo.server");
      expect(message).toContain("server-only file");
    }
  });

  it("case H: rule 1 still refuses a type-only import of a Node builtin — the carve-out is rule 2 only", async () => {
    try {
      await buildTypeOnlyPage("type-only-node-builtin.page.tsx", CORE_AS_SERVER);
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Import chain: type-only-node-builtin.page.tsx → node:fs");
      expect(message).toContain("Node.js builtin module");
    }
  });

  // SUBJECT CHANGED 2026-08-24: this case used to name `@warlock.js/core` as its
  // unmarked package. Core now declares `environment: "server"`, so it stopped
  // being an example of "unmarked" and the case failed — correctly. The fixture
  // now imports `@mongez/supportive-is`: governed scope (so rule 2 judges it),
  // genuinely unmarked, and pure enough that rule 1 cannot refuse it for a Node
  // builtin, which would make this pass for the wrong reason.
  //
  // What it guards is the permissive default, and that still matters: four
  // unreleased `@mongez/*` packages are imported from client positions, and
  // inverting the default would break apps on packages nobody here can fix.
  it("case I: an UNMARKED governed package's value import resolves normally — the permissive default is untouched", async () => {
    const result = await buildTypeOnlyPage("type-only-unmarked.page.tsx");
    const code = firstChunkCode(result);
    expect(code).toContain("type-only-unmarked-page");
    expect(code).toContain("core-value-binding");
  });
});

/**
 * RULE 4 AND THE MISSING FILE EXTENSION.
 *
 * Gate A judges a path it derives ITSELF, with `path.resolve`, from the raw
 * specifier — `resolveId` runs before anything appends an extension. Rule 4
 * then asks whether that path carries a code extension, because the rule has no
 * business judging `./logo.css`. Put together, those two facts used to mean the
 * rule could be stepped around by writing the import the way most people write
 * it anyway:
 *
 *     import { x } from "../services/helper";   // no extension -> not judged
 *
 * Measured on this fixture set before the fix: every one of cases 25-28 and 32
 * BUILT CLEAN. Case 9's own fixture comment records the same gap in prose
 * ("slips rule 4 entirely — a pre-existing gap"), which is why case 9 spells its
 * specifier `../services/outside-helper.ts` in full. That comment is now stale;
 * case 25 below is its extensionless twin and refuses.
 *
 * The fix completes the judged path the way Vite will actually resolve it —
 * `<path><ext>` then `<path>/index<ext>`, asked of the filesystem — so the rule
 * judges the file that will really be loaded.
 *
 * COVERED here: extensionless relative (case 25), a dotted trailing segment
 * that LOOKS like an extension and is not (case 26), directory/`index` (case
 * 27), `..` traversal that normalizes out of `web/` while still spelled `./`
 * (case 28), and an extension the completion can produce that rule 4's own
 * regex must also recognize (case 32).
 *
 * DELIBERATELY NOT COVERED: specifiers carrying a Vite query suffix
 * (`./helper?raw`, `./thing?worker`). Completion skips them entirely — the
 * query changes what the id MEANS to Vite, and guessing at that is a separate
 * decision from this one. `?raw`/`?worker` therefore remain an open route past
 * rule 4, reported as a followup rather than widened here. Traversal that
 * leaves `appRoot` altogether is not re-tested: case 13 already builds a
 * sibling package whose own internals import `./helper` extensionless, and it
 * must keep passing (it does).
 */
describe("gateAResolve — path completion is not escapable by omitting a file extension", () => {
  /** Entry pages. Under `web/` but one level in, so `*.page.tsx` is what admits them. */
  const EXT_PAGE_DIR = path.join(PAGE_DIR, "ext-gen");
  /** Targets OUTSIDE any `web/` folder — rule 4's subject. Sibling of `app/blog/web/`. */
  const EXT_SERVICES_DIR = path.join(FIXTURE_ROOT, "app", "blog", "ext-services");
  /** A target DIRECTLY inside the module's `web/` folder — the legitimate case. */
  const EXT_UNIVERSAL_FILE = path.join(PAGE_DIR, "ext-gen-universal.ts");
  /** The same, NESTED one folder deeper — `src/web/middleware/…` in the real app. */
  const EXT_NESTED_DIR = path.join(PAGE_DIR, "ext-gen-nested");

  beforeAll(() => {
    // SUBJECT MOVED 2026-08-24. These targets used to sit directly in
    // `ext-services/` and be refused by rule 4 for living outside `$module/web/`.
    // Rule 4 is gone — the boundary is decided by the import graph now — so a
    // plain file out there is legitimately ALLOWED (case 25b proves it).
    //
    // The property these cases actually guard is NOT rule 4. It is that PATH
    // COMPLETION makes an awkward spelling reach whichever rule judges the file
    // it resolves to: extensionless, a dotted segment that looks like an
    // extension, a directory resolving to index, `..` traversal, and `.mts`.
    // Without completion each of those walks past the fence untouched.
    //
    // So the targets moved into a `server/` folder, which rule 3 refuses by
    // location-of-a-declared-kind rather than by address. Same five spellings,
    // same completion machinery, a rule that still exists.
    writeFixture(
      path.join(EXT_SERVICES_DIR, "server", "plain.ts"),
      `export const extPlain = "ext-plain-value";\n`,
    );
    writeFixture(
      path.join(EXT_SERVICES_DIR, "server", "thing.middleware.ts"),
      `export const extMiddleware = "ext-middleware-value";\n`,
    );
    writeFixture(
      path.join(EXT_SERVICES_DIR, "server", "dir", "index.ts"),
      `export const extDirIndex = "ext-dir-index-value";\n`,
    );
    writeFixture(
      path.join(EXT_SERVICES_DIR, "server", "modern.mts"),
      `export const extModern = "ext-modern-value";\n`,
    );
    // The negative control for the rule-4 removal: outside `web/`, imports
    // nothing, therefore allowed. This is the false positive that removing
    // rule 4 was FOR.
    writeFixture(
      path.join(EXT_SERVICES_DIR, "harmless.ts"),
      `export const extHarmless = "ext-harmless-value";\n`,
    );
    writeFixture(
      path.join(EXT_SERVICES_DIR, "legacy.server.ts"),
      `export const extLegacyServer = "ext-legacy-server-value";\n`,
    );
    writeFixture(path.join(EXT_SERVICES_DIR, "data.json"), `{ "extData": "ext-json-value" }\n`);
    writeFixture(EXT_UNIVERSAL_FILE, `export const extUniversal = "ext-universal-value";\n`);
    writeFixture(
      path.join(EXT_NESTED_DIR, "base.middleware.ts"),
      `export const extNested = "ext-nested-value";\n`,
    );
  });

  afterAll(() => {
    rmSync(EXT_PAGE_DIR, { recursive: true, force: true });
    rmSync(EXT_SERVICES_DIR, { recursive: true, force: true });
    rmSync(EXT_UNIVERSAL_FILE, { force: true });
    rmSync(EXT_NESTED_DIR, { recursive: true, force: true });
  });

  /** Writes a throwaway page whose only job is to hold one import, and builds it. */
  async function buildExtPage(name: string, specifier: string, binding: string) {
    const file = path.join(EXT_PAGE_DIR, `${name}.page.tsx`);
    writeFixture(
      file,
      [
        `import { ${binding} } from "${specifier}";`,
        ``,
        `export default function Page() {`,
        `  return ${binding};`,
        `}`,
        ``,
      ].join("\n"),
    );
    return buildEntry(file);
  }

  /**
   * A refusal that names neither the file nor the specifier teaches people to
   * switch the fence off, so every completion case below asserts both.
   *
   * Asserts the RULE 3 message. It used to assert rule 4's ("lives outside this
   * module's web/ folder"); rule 4 was removed on 2026-08-24 and these cases
   * were re-pointed at a `server/` folder rather than deleted, because what they
   * guard is path completion, not the rule that happened to consume it.
   */
  function expectServerFileRefusal(message: string, specifier: string, pageName: string) {
    expect(message).toContain("Gate A refused an import");
    expect(message).toContain("is a server-only file");
    expect(message).toContain(`"${specifier}"`);
    expect(message).toContain(`${pageName}.page.tsx`);
    expect(message).toContain("Fix:");
  }

  it("case 25: an EXTENSIONLESS relative import of a file inside a server/ folder is refused", async () => {
    // The twin of case 9, which spells `.ts` out to work around this exact gap.
    try {
      await buildExtPage("ext25-plain", "../../ext-services/server/plain", "extPlain");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      expectServerFileRefusal((error as Error).message, "../../ext-services/server/plain", "ext25-plain");
      expect((error as Error).message).toContain(
        "Import chain: ext25-plain.page.tsx → ../../ext-services/server/plain",
      );
    }
  });

  it("case 26: a trailing DOTTED segment is not an extension — ./x.middleware is still judged", async () => {
    /*
      The shape the hole was reported through. `path.extname` answers
      ".middleware" here, so a check that merely asked "does this have an
      extension?" would still let it past; the file on disk is
      `thing.middleware.ts`.
    */
    try {
      await buildExtPage("ext26-dotted", "../../ext-services/server/thing.middleware", "extMiddleware");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      expectServerFileRefusal(
        (error as Error).message,
        "../../ext-services/server/thing.middleware",
        "ext26-dotted",
      );
    }
  });

  it("case 27: a DIRECTORY import resolving to index.ts is refused", async () => {
    try {
      await buildExtPage("ext27-dir", "../../ext-services/server/dir", "extDirIndex");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      expectServerFileRefusal((error as Error).message, "../../ext-services/server/dir", "ext27-dir");
    }
  });

  it("case 28: a ./-spelled specifier that TRAVERSES into server/ is refused on where it lands", async () => {
    /*
      Starts with `./`, so it reads like a sibling import, and normalizes to the
      same file case 25 refuses. The fence judges the resolved location, not the
      shape of the string.
    */
    const specifier = "./nested/../../../ext-services/server/plain";
    try {
      await buildExtPage("ext28-traversal", specifier, "extPlain");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      expectServerFileRefusal((error as Error).message, specifier, "ext28-traversal");
    }
  });

  it("case 25b (THE POINT OF REMOVING RULE 4): a file OUTSIDE web/ that imports nothing is ALLOWED", async () => {
    /*
      This is the false positive rule 4 produced, and the reason it is gone.

      `harmless.ts` sits outside `$module/web/` and imports nothing at all — the
      shape of `app/access/permissions.ts` in the real app, which is two frozen
      objects of permission-name constants that BOTH sides legitimately need.
      Rule 4 refused it for its address. Nothing about it is server-side.

      Its twin, case 25, is the same kind of file one folder deeper inside
      `server/` — and is still refused. Address alone no longer decides; what
      the file declares itself to be, and what it reaches, do.
    */
    const result = await buildExtPage("ext25b-harmless", "../../ext-services/harmless", "extHarmless");
    expect(firstChunkCode(result)).toContain("ext-harmless-value");
  });

  it("case 29 (NEGATIVE CONTROL): an extensionless import of a universal file INSIDE web/ still resolves", async () => {
    const result = await buildExtPage("ext29-universal", "../ext-gen-universal", "extUniversal");
    expect(firstChunkCode(result)).toContain("ext-universal-value");
  });

  it("case 30 (NEGATIVE CONTROL): a non-code file outside web/ is still exempt — rule 4 judges CODE", async () => {
    /*
      The guard against over-widening. Rule 4 exists to catch server logic
      leaking into the client bundle, not to police where a stylesheet or a data
      file lives, and completion must not turn `.json` into a code path.
    */
    const file = path.join(EXT_PAGE_DIR, "ext30-asset.page.tsx");
    writeFixture(
      file,
      [
        `import data from "../../ext-services/data.json";`,
        ``,
        `export default function Page() {`,
        `  return data.extData;`,
        `}`,
        ``,
      ].join("\n"),
    );
    expect(firstChunkCode(await buildEntry(file))).toContain("ext-json-value");
  });

  it("case 31 (NEGATIVE CONTROL): rule 3 still answers first for an extensionless *.server file", async () => {
    /*
      Completion runs BEFORE any rule, so it could in principle have changed
      which rule fires. `../../ext-services/legacy.server` is outside web/ AND
      server-named; it must report the server-only file, which is the actionable
      half.
    */
    try {
      await buildExtPage("ext31-server", "../../ext-services/legacy.server", "extLegacyServer");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("server-only file");
      expect(message).toContain('"../../ext-services/legacy.server"');
      expect(message).not.toContain("lives outside this module's web/ folder");
    }
  });

  /*
    Cases 33 and 34 are the ones that keep this slice from trading a false
    NEGATIVE for a false POSITIVE, and they are not hypothetical.

    `v5/app/src/web/root.tsx:5` reads `import { base } from
    "./middleware/base.middleware"` — the very specifier this hole was reported
    through. It resolves to `src/web/middleware/base.middleware.ts`, which is
    INSIDE `src/web/` and therefore universal by rule 4's own premise. But
    `isWithinModuleWebFolder` used to admit only files sitting DIRECTLY in a
    `web/` folder, so completing the extension without also fixing the depth
    would have made the reference app's root un-buildable. A fence that refuses
    the framework's own recommended layout is one people switch off.

    Case 34 shows the depth bug was never about extensions at all — the same
    file refused with its extension written out, before this slice — which is
    why it is fixed here rather than filed.
  */
  it("case 33 (NEGATIVE CONTROL): an extensionless import of a NESTED file under web/ still resolves", async () => {
    const result = await buildExtPage(
      "ext33-nested",
      "../ext-gen-nested/base.middleware",
      "extNested",
    );
    expect(firstChunkCode(result)).toContain("ext-nested-value");
  });

  it("case 34 (NEGATIVE CONTROL): the same nested file resolves WITH its extension too", async () => {
    const result = await buildExtPage(
      "ext34-nested-ext",
      "../ext-gen-nested/base.middleware.ts",
      "extNested",
    );
    expect(firstChunkCode(result)).toContain("ext-nested-value");
  });

  it("case 32: every extension the completion can produce is one the judging rule recognizes (.mts)", async () => {
    /*
      The self-inflicted-hole check. Completion walks a list of extensions and
      rule 4 then tests the result against its own regex; an entry the list can
      produce but the regex does not match would be a NEW extensionless escape
      wearing a suffix. `.mts` is the one that used to be exactly that — the
      regex predated it — so it is the case worth pinning.
    */
    try {
      await buildExtPage("ext32-mts", "../../ext-services/server/modern", "extModern");
      expect.unreachable("expected the build to fail");
    } catch (error) {
      expectServerFileRefusal((error as Error).message, "../../ext-services/server/modern", "ext32-mts");
    }
  });
});

/**
 * ONE TARGET FILE, FOUR SPELLINGS — AND THREE PIPELINES THAT DISAGREE.
 *
 * Every case above reaches a local file the way this repo's own fixtures are
 * written: relatively, or absolutely. A v5 app does not. `v5/app/tsconfig.json`
 * declares `app/*` -> `src/app/*` and `web/*` -> `src/web/*`, so nearly every
 * cross-tree import in application source is written in ALIAS form — and rule 4
 * used to open with `source.startsWith(".") || path.isAbsolute(source)`,
 * returning `false` for anything else. It judged the STRING, not the file.
 *
 * The obvious conclusion — "rules 3 and 4 are off for application source" — is
 * only a third right, and the third it is right about is the dangerous one.
 * Measured on this fixture tree, one target file, one import, three build
 * configurations:
 *
 *   A. `resolve.alias` HAS the entry (what `web-connector.ts` installs for the
 *      dev server). Vite's own alias plugin substitutes the specifier and
 *      re-enters resolution with the ABSOLUTE path, so Gate A never sees the
 *      alias string — it sees the file, and refuses. Rules 3 and 4 were
 *      already working here. This is why nothing in the fixture tree caught it.
 *
 *   B. `resolve.alias` has NO entry — which is the v5 PRODUCTION client build:
 *      `contribution.ts` passes `options.aliases ?? {}` and `warlock.config.ts`
 *      sets none. Nothing resolves the specifier, and Rollup does not fail on
 *      that: it warns `UNRESOLVED_IMPORT` and treats the import as EXTERNAL,
 *      writing `import { userResource } from "app/users/resources/user.resource"`
 *      verbatim into the browser chunk. Measured: build SUCCEEDED, chunk
 *      carried the specifier. That is the ADMITTED result, and it is not a rule
 *      being lenient — it is a file the fence never had.
 *
 *   C. Something else resolves the alias and returns a final id without
 *      re-entering resolution (the `vite-tsconfig-paths` shape). Gate A is
 *      handed the bare specifier, resolution succeeds, and rules 3 and 4 used
 *      to judge the string and admit it. This is the case the rule change
 *      actually turns on.
 *
 * THE PROPERTY, and the reason this suite is worth more than the per-rule cases
 * around it: a fence that answers differently depending on how an import was
 * SPELLED is not a fence — and one that answers differently depending on which
 * of three pipelines is running is worse, because the pipeline that stays quiet
 * is the one that ships. So the invariant asserted below is the one that holds
 * across all three: NO SPELLING OF A REFUSED FILE IS ADMITTED IN SILENCE.
 *
 * SEVERITY IS A SEPARATE AXIS, DELIBERATELY. Config A already refused, and
 * still does. Configs B and C are newly reported, and are reported as WARNINGS
 * — this is the one change to this gate with a measured, non-zero blast radius
 * in application source that BUILDS TODAY, and refusing on the same day the
 * rule starts judging would break working builds at sites nobody has surveyed.
 * The warnings name file, specifier and resolved path so the survey can be
 * taken. When it comes back empty, `this.warn` becomes `this.error` and cases
 * 35d and 36 below are what will change.
 */
describe("gateAResolve — the verdict follows the FILE, not the spelling", () => {
  /** Entry pages. Under `web/`, so only the imports they hold are on trial. */
  const SPELL_PAGE_DIR = path.join(PAGE_DIR, "spell-gen");
  /** Outside any `web/` folder, a sibling of `app/blog/web/`. */
  const SPELL_SERVICES_DIR = path.join(FIXTURE_ROOT, "app", "blog", "spell-services");
  /**
   * The ONE file every spelling below names.
   *
   * MOVED into `server/` on 2026-08-24. It used to sit directly in
   * `spell-services/` and be refused by rule 4 for its address; rule 4 is gone
   * (canon `10f6041c`), so a file there is now legitimately allowed and the
   * suite would have been asserting equivalence over a target nothing refuses —
   * which passes trivially and proves nothing.
   *
   * The PROPERTY is unchanged and is why this suite outlives the rule it was
   * written for: no spelling of a refused file may be admitted in silence.
   * Rule 3 refuses this target now; the four spellings must still agree.
   */
  const SPELL_TARGET = path.join(SPELL_SERVICES_DIR, "server", "user.resource.ts");
  /** Rule 3's plain-`server/`-folder half — the half a bare specifier escapes. */
  const SPELL_SERVER_DIR = path.join(SPELL_SERVICES_DIR, "server");
  /** The legitimate case: a universal file INSIDE the module's `web/` folder. */
  const SPELL_UNIVERSAL = path.join(PAGE_DIR, "spell-gen-universal.ts");

  /** CONFIG A — the alias entry `web-connector.ts` installs for the dev server. */
  const CONFIG_A: BuildHarness = {
    aliases: [{ find: /^app\//, replacement: `${normalizeSlashes(path.join(FIXTURE_ROOT, "app"))}/` }],
  };

  /** CONFIG B — the v5 production client build: no alias entry at all. */
  const CONFIG_B: BuildHarness = {};

  /**
   * CONFIG C — a resolver that answers the alias itself with a final absolute
   * id, never re-entering resolution. That is what `vite-tsconfig-paths` does,
   * and it is the shape under which Gate A is handed the bare specifier AND a
   * real file exists behind it. Deliberately carries no `enforce`, so it sits
   * after Gate A's `enforce: "pre"` and is reached by Gate A's `this.resolve`.
   */
  const pathsResolver: Plugin = {
    name: "spec:paths-resolver",
    resolveId(source) {
      if (!source.startsWith("app/")) return null;
      const base = path.join(FIXTURE_ROOT, "app", source.slice("app/".length));
      for (const extension of [".ts", ".tsx", ""]) {
        if (existsSync(`${base}${extension}`)) return normalizeSlashes(`${base}${extension}`);
      }
      return null;
    },
  };
  const CONFIG_C: BuildHarness = { plugins: [pathsResolver] };

  /** The two headlines Gate A prints for a judgement it is not enforcing yet. */
  const WOULD_REFUSE = "Gate A WOULD refuse this import";
  const COULD_NOT_JUDGE = "Gate A could not judge this import";

  beforeAll(() => {
    writeFixture(SPELL_TARGET, `export const spellTarget = "spell-target-value";\n`);
    writeFixture(path.join(SPELL_SERVER_DIR, "repo.ts"), `export const spellRepo = "spell-repo-value";\n`);
    writeFixture(SPELL_UNIVERSAL, `export const spellUniversal = "spell-universal-value";\n`);
  });

  afterAll(() => {
    rmSync(SPELL_PAGE_DIR, { recursive: true, force: true });
    rmSync(SPELL_SERVICES_DIR, { recursive: true, force: true });
    rmSync(SPELL_UNIVERSAL, { force: true });
  });

  /**
   * What Gate A did about one import, split into the three things that are NOT
   * the same question:
   *   - `report`: what the AUTHOR sees — a failed build, a warning, or nothing.
   *     "silence" is the verdict this whole suite exists to make impossible.
   *   - `rule`: WHICH rule found a violation, when one had a file to judge.
   *   - `emittedImports`: what Rollup left as an EXTERNAL import in the chunk.
   *     A specifier appearing here reached the browser without being bundled —
   *     the config-B shape, and the reason silence there is not harmless.
   */
  interface Verdict {
    report: "refused" | "would-refuse" | "could-not-judge" | "silence";
    rule: string | null;
    message: string;
    emittedImports: string[];
  }

  /** The rule a Gate A message names, read off its `Cause:` line. */
  function ruleOf(message: string): string | null {
    if (message.includes("lives outside this module's web/ folder")) return "rule 4 — outside $module/web/";
    if (message.includes("is a server-only file")) return "rule 3 — server-only file";
    if (message.includes("is a Node.js builtin module")) return "rule 1 — node builtin";
    if (message.includes("server-only @warlock.js package")) return "rule 2 — server-marked package";
    return null;
  }

  /**
   * Builds a throwaway page holding exactly one import of `specifier` and
   * reports the verdict. A refusal throws; a warning does not — the build
   * SUCCEEDS and the only trace is on `onwarn` — which is why all three
   * outcomes are collected here rather than in a `rejects.toThrow`.
   */
  async function verdictFor(
    name: string,
    specifier: string,
    binding: string,
    harness: BuildHarness,
  ): Promise<Verdict> {
    const file = path.join(SPELL_PAGE_DIR, `${name}.page.tsx`);
    writeFixture(
      file,
      [
        `import { ${binding} } from "${specifier}";`,
        ``,
        `export default function Page() {`,
        `  return ${binding};`,
        `}`,
        ``,
      ].join("\n"),
    );

    const warnings: string[] = [];
    let result: Awaited<ReturnType<typeof buildEntry>>;
    try {
      result = await buildEntry(file, {}, {
        ...harness,
        onwarn: (warning) => {
          if (typeof warning.message === "string") warnings.push(warning.message);
        },
      });
    } catch (error) {
      const message = (error as Error).message;
      return { report: "refused", rule: ruleOf(message), message, emittedImports: [] };
    }

    const output = Array.isArray(result) ? result[0] : result;
    const chunk = "output" in output ? output.output[0] : undefined;
    const emittedImports = chunk && chunk.type === "chunk" ? [...chunk.imports] : [];

    const wouldRefuse = warnings.find((message) => message.includes(WOULD_REFUSE));
    if (wouldRefuse) {
      return { report: "would-refuse", rule: ruleOf(wouldRefuse), message: wouldRefuse, emittedImports };
    }
    const couldNotJudge = warnings.find((message) => message.includes(COULD_NOT_JUDGE));
    if (couldNotJudge) {
      return { report: "could-not-judge", rule: null, message: couldNotJudge, emittedImports };
    }
    return { report: "silence", rule: null, message: warnings.join("\n"), emittedImports };
  }

  /** The alias spelling — the one the v5 app writes. */
  const ALIAS_SPELLING = "app/blog/spell-services/server/user.resource";
  /** The three spellings that name the same file the ordinary way. */
  const LOCAL_SPELLINGS: { label: string; specifier: string }[] = [
    { label: "relative, no extension", specifier: "../../spell-services/server/user.resource" },
    { label: "relative, with extension", specifier: "../../spell-services/server/user.resource.ts" },
    { label: "absolute", specifier: normalizeSlashes(SPELL_TARGET) },
  ];

  // Was `RULE_FOUR = "rule 4 — outside $module/web/"`. Rule 4 was removed on
  // 2026-08-24 (canon `10f6041c`) and this suite's target moved into `server/`,
  // so the rule that now refuses every spelling of it is rule 3. The suite's
  // assertion is unchanged in substance: all four spellings must agree, and
  // none may be admitted in silence.
  const REFUSING_RULE = "rule 3 — server-only file";

  it("case 35 (THE EQUIVALENCE): under every pipeline, no spelling of a refused file is admitted in SILENCE", async () => {
    /*
      The one assertion that would have caught this, and the one worth keeping
      when the severities eventually converge. Before the fix, the two alias
      rows read "silence" — nothing thrown, nothing warned, nothing for anyone
      to act on. Note what is compared: whether the author was TOLD, not what
      it cost them. Severity is pinned separately in 35c/35d.
    */
    const verdicts: Record<string, string> = {};
    for (const [index, spelling] of LOCAL_SPELLINGS.entries()) {
      const verdict = await verdictFor(`spell35-local-${index}`, spelling.specifier, "spellTarget", CONFIG_A);
      verdicts[spelling.label] = verdict.report;
    }
    verdicts["alias — config A (alias table present)"] = (
      await verdictFor("spell35-a", ALIAS_SPELLING, "spellTarget", CONFIG_A)
    ).report;
    verdicts["alias — config B (no alias table: the v5 client build)"] = (
      await verdictFor("spell35-b", ALIAS_SPELLING, "spellTarget", CONFIG_B)
    ).report;
    verdicts["alias — config C (a paths resolver answers it)"] = (
      await verdictFor("spell35-c", ALIAS_SPELLING, "spellTarget", CONFIG_C)
    ).report;

    expect(verdicts).toEqual({
      "relative, no extension": "refused",
      "relative, with extension": "refused",
      absolute: "refused",
      // Vite's alias plugin substitutes and re-enters, so Gate A judges the
      // file — this row was already correct and must stay correct.
      "alias — config A (alias table present)": "refused",
      // Nothing resolves it, so no rule has a file. Reported instead of silent.
      "alias — config B (no alias table: the v5 client build)": "could-not-judge",
      // A file exists and rules 3/4 now judge it. Warned, not yet refused.
      "alias — config C (a paths resolver answers it)": "would-refuse",
    });
  });

  it("case 35b: under config C, the alias form is judged and names the file it resolved to", async () => {
    /*
      The rule change itself. Gate A is handed the bare specifier
      `app/blog/spell-services/server/user.resource`; rule 4 used to test that string
      for a code extension, find none, and decline to judge. It now judges the
      path resolution actually reached.
    */
    const verdict = await verdictFor("spell35b", ALIAS_SPELLING, "spellTarget", CONFIG_C);
    expect(verdict.rule).toBe(REFUSING_RULE);
    expect(verdict.message).toContain(`"${ALIAS_SPELLING}"`);
    expect(verdict.message).toContain("spell35b.page.tsx");
    // The survey line: the file that would have been refused, resolved.
    expect(verdict.message).toContain(normalizeSlashes(SPELL_TARGET));
    expect(verdict.message).toContain("Fix:");
  });

  it("case 35c (SEVERITY): the spellings that were already refused still FAIL the build", async () => {
    // Nothing here is being softened. The three ordinary spellings, and the
    // alias spelling under config A, all still stop the build.
    for (const [index, spelling] of LOCAL_SPELLINGS.entries()) {
      const verdict = await verdictFor(`spell35c-${index}`, spelling.specifier, "spellTarget", CONFIG_A);
      expect(verdict.report, spelling.label).toBe("refused");
      expect(verdict.message, spelling.label).toContain("Gate A refused an import");
    }
    const aliasUnderA = await verdictFor("spell35c-alias", ALIAS_SPELLING, "spellTarget", CONFIG_A);
    expect(aliasUnderA.report).toBe("refused");
    expect(aliasUnderA.rule).toBe(REFUSING_RULE);
  });

  it("case 35d (SEVERITY): the newly-judged alias form WARNS — a build that works today is not broken today", async () => {
    /*
      The deliberate asymmetry, and the line to change when the survey is
      clean. Config C is where rules 3 and 4 have just started judging alias
      form, and config B is where the fence has no file at all; both were
      silent this morning. Turning either into a refusal today would break a
      working build at sites nobody has fixed yet, so the violation is
      REPORTED, in full, and the build proceeds.
    */
    const underC = await verdictFor("spell35d-c", ALIAS_SPELLING, "spellTarget", CONFIG_C);
    expect(underC.report).toBe("would-refuse");
    expect(underC.message).toContain("Why only a warning:");

    const underB = await verdictFor("spell35d-b", ALIAS_SPELLING, "spellTarget", CONFIG_B);
    expect(underB.report).toBe("could-not-judge");
    expect(underB.message).toContain(`"${ALIAS_SPELLING}"`);
    expect(underB.message).toContain("spell35d-b.page.tsx");
    expect(underB.message).toContain("resolve.alias declares");
  });

  it("case 35e: config B's unresolved import really does reach the chunk verbatim — which is why silence was not harmless", async () => {
    /*
      The measurement behind the warning, asserted rather than described.
      Rollup does not fail on an unresolved bare specifier: it externalizes it.
      So the v5 production client build emits the import statement into the
      browser untouched — no rule consulted, no file bundled, and a specifier
      naming a server-side module sitting in a client chunk.
    */
    const verdict = await verdictFor("spell35e", ALIAS_SPELLING, "spellTarget", CONFIG_B);
    expect(verdict.emittedImports).toContain(ALIAS_SPELLING);
    expect(verdict.report).toBe("could-not-judge");
  });

  it("case 35f (NEGATIVE CONTROL): a legitimate alias import of a UNIVERSAL file does not warn, under A or C", async () => {
    /*
      Without this, a green suite would be satisfied by flagging everything
      alias-shaped, which is the failure mode a warn-first rollout invites: a
      wall of warnings that says nothing and gets muted. `app/blog/web/...` is
      inside the module's `web/` folder and is admitted by rule 4's own
      premise, alias or not.
    */
    const underA = await verdictFor(
      "spell35f-a",
      "app/blog/web/spell-gen-universal",
      "spellUniversal",
      CONFIG_A,
    );
    expect(underA.report).toBe("silence");

    const underC = await verdictFor(
      "spell35f-c",
      "app/blog/web/spell-gen-universal",
      "spellUniversal",
      CONFIG_C,
    );
    expect(underC.report).toBe("silence");
  });

  it("case 35g (NEGATIVE CONTROL): the relative spelling of that same universal file is admitted too", async () => {
    // The other half of 35f: equivalence has to hold for CLEAN files as well,
    // or "no silent admission" collapses into "warn about everything".
    const verdict = await verdictFor("spell35g", "../spell-gen-universal", "spellUniversal", CONFIG_B);
    expect(verdict.report).toBe("silence");
    expect(verdict.emittedImports).toEqual([]);
  });

  it("case 36: rule 3's plain server/ FOLDER half now judges alias form too — as a warning", async () => {
    /*
      Rule 3 has two halves and only one of them was reaching alias form. The
      `.server` NAME half matches the specifier STRING itself, so
      `app/x/thing.server` was already refused by accident. The plain `server/`
      FOLDER half is gated on `isAppSourcePath`, which a bare specifier string
      can never satisfy — so `app/blog/spell-services/server/repo` was admitted
      while `../../spell-services/server/repo` was refused. Same file.
    */
    const alias = await verdictFor(
      "spell36-alias",
      "app/blog/spell-services/server/repo",
      "spellRepo",
      CONFIG_C,
    );
    const relative = await verdictFor(
      "spell36-rel",
      "../../spell-services/server/repo",
      "spellRepo",
      CONFIG_C,
    );

    expect(alias.rule).toBe("rule 3 — server-only file");
    expect(relative.rule).toBe("rule 3 — server-only file");
    expect(alias.report).toBe("would-refuse");
    expect(relative.report).toBe("refused");
    expect(alias.message).toContain("server/ folder");
  });
});

