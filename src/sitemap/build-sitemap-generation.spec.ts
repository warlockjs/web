import config from "@mongez/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSitemapGeneration } from "./build-sitemap-generation";
import { resolveSitemapConfig } from "./resolve-sitemap-config";

const temporaryDirectories: string[] = [];

function makeAppTree(): string {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-sitemap-stage-spec-"));
  temporaryDirectories.push(appRoot);
  const pagePath = path.join(appRoot, "src", "web", "about.page.tsx");

  fs.mkdirSync(path.dirname(pagePath), { recursive: true });
  fs.writeFileSync(
    pagePath,
    [
      'export const config = { route: "/about" };',
      "export default function Page() { return null; }",
    ].join("\n"),
  );

  return appRoot;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }

  config.set("app", {});
  config.set("web", {});
});

describe("buildSitemapGeneration", () => {
  it("stages a generation under its own temporary root and returns owned artifact metadata", async () => {
    const appRoot = makeAppTree();
    config.set("app", { publicUrl: "https://example.test" });
    config.set("web", { sitemap: { enabled: true } });

    const staged = await buildSitemapGeneration({
      generationId: "generation_01",
      resolvedConfig: resolveSitemapConfig(),
      options: { appRoot },
    });

    expect(staged.stageDir).toContain("generation_01");
    expect(staged.mainFilePath).toBe(path.join(staged.stageDir, "sitemap.xml"));
    expect(staged.artifacts).toEqual([
      { path: staged.mainFilePath, type: "sitemap", gzipped: false, count: 1 },
    ]);
    expect(fs.existsSync(staged.mainFilePath)).toBe(true);

    await staged.cleanup();
    expect(fs.existsSync(staged.stageDir)).toBe(false);
  });

  it.each(["../escape", "generation/one", "generation one", ""])(
    "refuses an unsafe generation id %#",
    async (generationId) => {
      config.set("app", { publicUrl: "https://example.test" });
      config.set("web", { sitemap: { enabled: true } });

      await expect(
        buildSitemapGeneration({
          generationId,
          resolvedConfig: resolveSitemapConfig(),
        }),
      ).rejects.toThrow(/generationId/);
    },
  );
});
