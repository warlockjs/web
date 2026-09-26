import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import config from "@mongez/config";
import type { SitesConfig } from "../sites/site-config.types";
import { formatBuildLogMessage } from "./build-client";
import {
  createHydrationClientEntry,
  createHydrationSiteInputs,
  findSiteHydrationEntryFile,
  siteOfHydrationEntryId,
} from "./hydration-entries";
import {
  CLIENT_PAGE_REGISTRY_ID,
  clientPageRegistry,
  RESOLVED_CLIENT_PAGE_REGISTRY_ID,
  resolvedSiteRegistryId,
  siteRegistryId,
} from "./page-registry-plugin";
import { buildWarlockHydrationClient } from "./index";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const SITES: SitesConfig = {
  landing: { pages: "(landing)", hosts: ["a.test"] },
  platform: { pages: "(platform)", hosts: ["b.test"] },
};

const COMPONENT = "export default function C() { return null; }\n";
const page = (name: string, route: string) =>
  `export const config = { route: { path: "${route}", name: "${name}" } };\n${COMPONENT}`;

function makeApp(multi: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-multi-site-registry-"));
  roots.push(root);
  const files: Record<string, string> = multi
    ? {
        "src/web/(landing)/root.tsx": COMPONENT,
        "src/web/(landing)/home.page.tsx": page("home", "/"),
        "src/web/(platform)/root.tsx": COMPONENT,
        "src/web/(platform)/dashboard.page.tsx": page("dashboard", "/dashboard"),
      }
    : { "src/web/root.tsx": COMPONENT, "src/web/home.page.tsx": page("home", "/") };
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf-8");
  }
  return root;
}

function hooks(plugin: ReturnType<typeof clientPageRegistry>) {
  return {
    resolveId: (source: string, importer?: string) =>
      (plugin.resolveId as (s: string, i?: string) => unknown)(source, importer),
    load: (id: string) => (plugin.load as (id: string) => unknown)(id) as string | undefined,
  };
}

describe("per-site virtual page registries", () => {
  it("serves one registry per site containing only that site's pages", () => {
    const appRoot = makeApp(true);
    const { resolveId, load } = hooks(clientPageRegistry({ appRoot, sites: SITES }));

    expect(resolveId(siteRegistryId("landing"))).toBe(resolvedSiteRegistryId("landing"));
    expect(resolveId(siteRegistryId("platform"))).toBe(resolvedSiteRegistryId("platform"));

    const landing = load(resolvedSiteRegistryId("landing"))!;
    const platform = load(resolvedSiteRegistryId("platform"))!;

    expect(landing).toContain("home.page.tsx");
    expect(landing).not.toContain("dashboard.page.tsx");
    expect(platform).toContain("dashboard.page.tsx");
    expect(platform).not.toContain("home.page.tsx");
  });

  it("emits each site's effective locale routing table", () => {
    const appRoot = makeApp(true);
    config.set("web", { localeRouting: { strategy: "prefix-except-default" } });
    config.set("app", { localeCodes: ["en", "ar"], localeCode: "en" });

    try {
      const sites: SitesConfig = {
        landing: { ...SITES.landing!, localeRouting: { strategy: "prefix" } },
        platform: { ...SITES.platform!, localeRouting: {} },
      };
      const { load } = hooks(clientPageRegistry({ appRoot, sites }));

      expect(load(resolvedSiteRegistryId("landing"))).toContain('strategy: "prefix"');
      expect(load(resolvedSiteRegistryId("platform"))).toContain('strategy: "none"');
    } finally {
      config.set("web", {});
      config.set("app", {});
    }
  });

  it("redirects the shared entry's registry import to the site named in the entry id", () => {
    const appRoot = makeApp(true);
    const { resolveId } = hooks(clientPageRegistry({ appRoot, sites: SITES }));
    const entry = createHydrationClientEntry(path.resolve(__dirname, "..", ".."));
    const inputs = createHydrationSiteInputs(entry, ["landing", "platform"]);

    expect(resolveId(CLIENT_PAGE_REGISTRY_ID, inputs["hydration-platform"])).toBe(
      resolvedSiteRegistryId("platform"),
    );
    expect(siteOfHydrationEntryId(inputs["hydration-landing"])).toBe("landing");
  });

  it("keeps the single-site registry and resolution unchanged", () => {
    const appRoot = makeApp(false);
    const { resolveId, load } = hooks(clientPageRegistry({ appRoot }));

    expect(resolveId(CLIENT_PAGE_REGISTRY_ID)).toBe(RESOLVED_CLIENT_PAGE_REGISTRY_ID);
    expect(resolveId(siteRegistryId("landing"))).toBeUndefined();
    expect(load(RESOLVED_CLIENT_PAGE_REGISTRY_ID)).toBe(
      load(RESOLVED_CLIENT_PAGE_REGISTRY_ID),
    );
    expect(load(RESOLVED_CLIENT_PAGE_REGISTRY_ID)).toContain("home.page.tsx");
    expect(load(resolvedSiteRegistryId("landing"))).toBeUndefined();
  });
});

describe("hydration entries and manifest lookup", () => {
  const entry = createHydrationClientEntry(path.resolve(__dirname, "..", ".."));

  it("builds one hydration-<site> rollup input per site", () => {
    const inputs = createHydrationSiteInputs(entry, ["landing", "platform"]);

    expect(Object.keys(inputs)).toEqual(["hydration-landing", "hydration-platform"]);
    expect(inputs["hydration-landing"]).toBe(`${entry.sourcePath}?warlock-site=landing`);
  });

  it("the single-site entry is untouched: name `hydration`, no query", () => {
    expect(entry.name).toBe("hydration");
    expect(siteOfHydrationEntryId(entry.sourcePath)).toBeUndefined();
  });

  it("finds a site's emitted entry asset in the vite manifest", () => {
    const manifest = {
      "src/entry/index.ts?warlock-site=landing": {
        name: "hydration-landing",
        isEntry: true,
        file: "assets/hydration-landing-abc.js",
      },
      "src/entry/index.ts?warlock-site=platform": {
        name: "hydration-platform",
        isEntry: true,
        file: "assets/hydration-platform-def.js",
      },
    };

    expect(findSiteHydrationEntryFile(manifest, "platform")).toBe("assets/hydration-platform-def.js");
    expect(findSiteHydrationEntryFile(manifest, "missing")).toBeUndefined();
  });
});

describe("multi-site build orchestration", () => {
  it("threads sites through the exported build helper into per-site registries and Rollup inputs", async () => {
    const appRoot = makeApp(true);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-multi-site-build-"));
    const webRoot = path.resolve(__dirname, "..", "..");

    try {
      const result = await buildWarlockHydrationClient({
        appRoot,
        webRoot,
        outDir,
        resolveAliases: [
          { find: "web", replacement: webRoot },
          { find: "@warlock.js/web/client/runtime", replacement: path.join(webRoot, "src/client/runtime") },
        ],
        sites: SITES,
      });
      const outputs = Array.isArray(result.output) ? result.output : [result.output];
      const entries = outputs
        .flatMap((output) => output.output)
        .filter((file) => file.type === "chunk" && file.isEntry)
        .map((file) => file.name)
        .sort();

      expect(entries).toEqual(["hydration-landing", "hydration-platform"]);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("dev invalidation is scoped per site", () => {
  it("a change under one site's folder invalidates only that site's registry", async () => {
    const appRoot = makeApp(true);
    const plugin = clientPageRegistry({ appRoot, sites: SITES });
    const invalidated: string[] = [];
    const modules = new Map(
      [resolvedSiteRegistryId("landing"), resolvedSiteRegistryId("platform"), RESOLVED_CLIENT_PAGE_REGISTRY_ID].map(
        (id) => [id, { id }],
      ),
    );
    const server = {
      environments: {
        client: {
          moduleGraph: {
            getModuleById: (id: string) => modules.get(id),
            invalidateModule: (module: { id: string }) => invalidated.push(module.id),
          },
        },
      },
      hot: { send: vi.fn() },
    };

    const hotUpdate = plugin.hotUpdate as unknown as (
      this: unknown,
      context: unknown,
    ) => Promise<unknown>;

    await hotUpdate.call(
      { environment: { name: "client" } },
      {
        file: path.join(appRoot, "src/web/(landing)/root.tsx"),
        type: "update",
        server,
      },
    );

    expect(invalidated).toEqual([resolvedSiteRegistryId("landing")]);
  });
});

describe("build log paths", () => {
  it("rewrites the web-package-relative output dir to an app-root-relative one", () => {
    const appRoot = path.resolve("/work/apps/web");
    const outDir = path.join(appRoot, "dist", "client");
    const viteRoot = path.resolve("/work/node_modules/@warlock.js/web");
    const printed = path.relative(viteRoot, outDir).split(path.sep).join("/");

    expect(
      formatBuildLogMessage(`${printed}/assets/hydration-x.js  10 kB`, { viteRoot, logRoot: appRoot, outDir }),
    ).toBe("dist/client/assets/hydration-x.js  10 kB");
  });

  it("leaves messages without the prefix alone", () => {
    const outDir = path.resolve("/a/dist/client");
    expect(
      formatBuildLogMessage("transforming...", { viteRoot: path.resolve("/b"), logRoot: path.resolve("/a"), outDir }),
    ).toBe("transforming...");
  });
});
