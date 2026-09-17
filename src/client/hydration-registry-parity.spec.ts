/**
 * GUARD: the server writes a page's route NAME into the hydration payload
 * (`../hydration-payload.ts`'s `name` key, filled by
 * `../server/install-page-routes.ts` at dev-request time and by
 * `../server/install-page-routes-from-manifest.ts` in production), and the
 * client resolves that request's component by looking that same string up in
 * the generated page registry (`../build/generate-client-registry.ts`,
 * served in dev by `../vite/page-registry-plugin.ts`'s virtual module and in
 * production by the barrel `../build/generate-pages-barrel.ts` writes).
 *
 * Both sides are SUPPOSED to agree structurally: `../build/discover-pages.ts`
 * runs ONE filesystem scan and feeds both the client registry generator and
 * (through the barrel's `sourceFile`) the production installer. But that
 * agreement depends on every caller computing the SAME "path relative to the
 * page root" string before handing it to the shared
 * `../routing/route-identity.ts#resolvePageRouteName` — and there are two
 * independent computations of that string:
 *
 *   - `../server/install-page-routes.ts#filesystemPageFileFor` (dev server,
 *     called per-request against an absolute page file + `appSrcRoot`)
 *   - `../build/discover-pages.ts`'s own internal `relativePageFile`, which
 *     is what ends up as `DiscoveredRoutablePage.routeName` and, verbatim,
 *     the client registry's `name`.
 *
 * This spec builds a REAL fixture app tree on disk (Windows backslash paths,
 * since this suite always runs on win32) covering an index page, a nested
 * page, a `[param]` page, a `[...slug]` catch-all, and a page inside a
 * `(group)`, then calls the REAL production functions on both sides —
 * `filesystemPageFileFor` + `resolvePageRouteIdentity` for the server name,
 * and `discoverPages` + `generateClientRegistry` (executed for real, exactly
 * as `generate-client-registry.spec.ts` does) for the client registry key —
 * and asserts they agree for every page.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { transform } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { discoverPages, isDiscoveredRoutablePage } from "../build/discover-pages";
import { CLIENT_REGISTRY_EXPORT_NAME, generateClientRegistry } from "../build/generate-client-registry";
import { validateClientRouteManifest } from "./runtime/manifest";
import { filesystemPageFileFor } from "../server/install-page-routes";
import { resolvePageRouteIdentity } from "../routing/route-identity";
import type { PageRouteExport } from "../server/page-module-shapes";

const temporaryDirectories: string[] = [];

/** Materialises a fixture app tree: `{ "src/web/root.tsx": "…" }` under a temp root. */
function makeAppTree(files: Record<string, string>): string {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-hydration-parity-"));
  temporaryDirectories.push(appRoot);

  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(appRoot, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf-8");
  }

  return appRoot;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

const APP = "export default function App() { return null; }\n";

function page(): string {
  return "export default function Page() { return null; }\n";
}

/**
 * Same trick `generate-client-registry.spec.ts` uses: every emitted
 * specifier is executed for real, so a divergence would surface as either a
 * mismatched `name` or (for a genuinely malformed registry) a parse/runtime
 * failure — never a string comparison against a second hand-written copy of
 * the generator's output.
 */
function toDataUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source, "utf-8").toString("base64")}`;
}

function stubSpecifier(absoluteFilePath: string): string {
  return toDataUrl(
    `export const sourceFile = ${JSON.stringify(absoluteFilePath)};\n` +
      "export function register() {}\n" +
      "export default function Component() {}",
  );
}

async function clientRegistryNames(appRoot: string): Promise<Record<string, string>> {
  const pages = discoverPages({ appRoot });
  const source = generateClientRegistry({ pages, toImportSpecifier: stubSpecifier });
  const { code } = await transform(source, { loader: "ts", format: "esm" });
  const namespace = (await import(/* @vite-ignore */ toDataUrl(code))) as Record<string, unknown>;
  const entries = validateClientRouteManifest(namespace[CLIENT_REGISTRY_EXPORT_NAME]);

  const byPageFile: Record<string, string> = {};
  const routablePages = pages.filter(isDiscoveredRoutablePage);

  // `generateClientRegistry` preserves discovery's own order (its own doc
  // comment, `../build/generate-client-registry.ts:34-42`), so zipping the
  // two arrays by index recovers which entry belongs to which fixture page
  // without re-deriving anything the generator already decided.
  routablePages.forEach((discovered, index) => {
    const entry = entries[index];

    if (entry === undefined) {
      throw new Error(`Client registry has no entry for ${discovered.pageFile}.`);
    }

    byPageFile[discovered.pageFile] = entry.name;
  });

  return byPageFile;
}

/** The server's own name derivation, exactly as `install-page-routes.ts` calls it per request. */
function serverName(
  pageFile: string,
  appSrcRoot: string,
  route: PageRouteExport | undefined,
): string {
  const relative = filesystemPageFileFor(pageFile, appSrcRoot);

  return resolvePageRouteIdentity(route, relative, pageFile).name;
}

describe("hydration payload name / client registry key parity", () => {
  it("agree for index, nested, [param], [...slug], route-group and Windows-path pages", async () => {
    const appRoot = makeAppTree({
      "src/web/root.tsx": APP,
      "src/web/index.page.tsx": page(),
      "src/web/blog/archive.page.tsx": page(),
      "src/web/users/[id].page.tsx": page(),
      "src/web/docs/[...slug].page.tsx":
        `export const route = { path: "/docs/*", name: "docs.catchAll" };\n${page()}`,
      "src/web/(marketing)/about.page.tsx": page(),
    });

    // Every path below is an OS-native absolute path — on this win32 suite,
    // that means real backslashes, exercised through the same disk reads and
    // `path.relative` calls the running application would make.
    expect(appRoot.includes("\\")).toBe(true);

    const appSrcRoot = path.join(appRoot, "src");
    const clientNames = await clientRegistryNames(appRoot);

    const cases: Array<{ label: string; pageFile: string; route: PageRouteExport | undefined }> = [
      {
        label: "index page",
        pageFile: path.join(appSrcRoot, "web", "index.page.tsx"),
        route: undefined,
      },
      {
        label: "nested page",
        pageFile: path.join(appSrcRoot, "web", "blog", "archive.page.tsx"),
        route: undefined,
      },
      {
        label: "[param] page",
        pageFile: path.join(appSrcRoot, "web", "users", "[id].page.tsx"),
        route: undefined,
      },
      {
        label: "[...slug] catch-all page",
        pageFile: path.join(appSrcRoot, "web", "docs", "[...slug].page.tsx"),
        route: { path: "/docs/*", name: "docs.catchAll" },
      },
      {
        label: "page inside a (group)",
        pageFile: path.join(appSrcRoot, "web", "(marketing)", "about.page.tsx"),
        route: undefined,
      },
    ];

    expect(cases).toHaveLength(5);

    for (const testCase of cases) {
      const expectedServerName = serverName(testCase.pageFile, appSrcRoot, testCase.route);
      const actualClientName = clientNames[testCase.pageFile];

      expect(
        actualClientName,
        `${testCase.label}: hydration payload name "${expectedServerName}" must match the ` +
          `client registry key discovered for "${testCase.pageFile}"`,
      ).toBe(expectedServerName);
    }
  });
});
