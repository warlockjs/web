import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareDevRouteLocaleArtifact } from "./dev-route-locale-artifact";

const roots: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-dev-route-locales-"));
  roots.push(root);
  for (const [file, source] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, "utf-8");
  }
  return root;
}

function options(root: string, localeFile = "src/web/locales.json") {
  return {
    appRoot: root,
    artifactPath: path.join(root, ".warlock", "route-locales.manifest.json"),
    localeCodes: ["en", "ar"],
    localeCode: "en",
    graph: {
      pages: [
        {
          pageFile: path.join(root, "src/web/account/page.page.tsx"),
          webRoot: path.join(root, "src/web"),
        },
      ],
      localeFiles: [
        { sourceFile: path.join(root, localeFile), webRoot: path.join(root, "src/web") },
      ],
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("prepareDevRouteLocaleArtifact", () => {
  it("persists an empty graph after all locale files are removed", () => {
    const root = fixture({});
    const input = options(root);
    input.graph.localeFiles = [];
    const prepared = prepareDevRouteLocaleArtifact(input);
    expect(prepared.manifest).toBeUndefined();
    prepared.commit();
    prepared.dispose();
    expect(JSON.parse(fs.readFileSync(input.artifactPath, "utf8")).localeFiles).toEqual([]);
    expect(fs.readdirSync(path.dirname(input.artifactPath))).toEqual([
      path.basename(input.artifactPath),
    ]);
  });

  it("stages portable raw source and commits it only when asked", () => {
    const root = fixture({
      "src/web/locales.json": '{"shared":{"title":{"en":"Title","ar":"عنوان"}}}',
    });
    const input = options(root);
    fs.mkdirSync(path.dirname(input.artifactPath), { recursive: true });
    fs.writeFileSync(input.artifactPath, "prior", "utf-8");

    const prepared = prepareDevRouteLocaleArtifact(input);
    expect(fs.readFileSync(input.artifactPath, "utf-8")).toBe("prior");
    expect(
      prepared.manifest?.pages[path.join(root, "src/web/account/page.page.tsx")]
        ?.translationsByLocale.en,
    ).toEqual({
      shared: { title: "Title" },
    });

    prepared.commit();
    const artifact = JSON.parse(fs.readFileSync(input.artifactPath, "utf-8"));
    expect(artifact).toEqual({
      version: 1,
      pages: [{ pageFile: "src/web/account/page.page.tsx", webRoot: "src/web" }],
      localeFiles: [
        {
          sourceFile: "src/web/locales.json",
          webRoot: "src/web",
          source: '{"shared":{"title":{"en":"Title","ar":"عنوان"}}}',
        },
      ],
    });
  });

  it("keeps the staged snapshot independent of later source edits or deletion", () => {
    const root = fixture({
      "src/web/account/locales.json":
        '{"$group":"profile.copy","title":{"en":"Original","ar":"أصل"}}',
    });
    const input = options(root, "src/web/account/locales.json");
    const prepared = prepareDevRouteLocaleArtifact(input);
    fs.writeFileSync(path.join(root, "src/web/account/locales.json"), "{}", "utf-8");
    fs.rmSync(path.join(root, "src/web/account/locales.json"));

    expect(prepared.manifest?.keys).toEqual(["profile.copy.title"]);
    expect(
      prepared.manifest?.pages[path.join(root, "src/web/account/page.page.tsx")]
        ?.translationsByLocale.en,
    ).toEqual({
      profile: { copy: { title: "Original" } },
    });
    prepared.dispose();
    expect(fs.existsSync(input.artifactPath)).toBe(false);
  });

  it("preserves a prior artifact when source validation or runtime locale configuration fails", () => {
    const root = fixture({ "src/web/locales.json": '{"title":{"en":42}}' });
    const input = options(root);
    fs.mkdirSync(path.dirname(input.artifactPath), { recursive: true });
    fs.writeFileSync(input.artifactPath, "prior", "utf-8");

    expect(() => prepareDevRouteLocaleArtifact(input)).toThrow();
    expect(fs.readFileSync(input.artifactPath, "utf-8")).toBe("prior");

    fs.writeFileSync(
      path.join(root, "src/web/locales.json"),
      '{"title":{"en":"Title","ar":"عنوان"}}',
      "utf-8",
    );
    expect(() => prepareDevRouteLocaleArtifact({ ...input, localeCode: "fr" })).toThrow(
      /not present/u,
    );
    expect(fs.readFileSync(input.artifactPath, "utf-8")).toBe("prior");
  });
});
