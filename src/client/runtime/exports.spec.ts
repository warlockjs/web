import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type PackageExport = {
  types: string;
  import: string;
  default: string;
};

type PackageJson = {
  exports: Record<string, PackageExport>;
};

const packageJson = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as PackageJson;
describe("client package export", () => {
  it("preserves the existing root and deep-import targets", () => {
    expect(packageJson.exports["."]).toEqual({
      types: "./src/index.ts",
      import: "./src/index.ts",
      default: "./src/index.ts",
    });
    expect(packageJson.exports["./connector"]).toEqual({
      types: "./src/connector/index.ts",
      import: "./src/connector/index.ts",
      default: "./src/connector/index.ts",
    });
    expect(packageJson.exports["./vite"]).toEqual({
      types: "./src/vite/index.ts",
      import: "./src/vite/index.ts",
      default: "./src/vite/index.ts",
    });
  });

  it("targets only the public client runtime barrel", () => {
    const clientExport = packageJson.exports["./client/runtime"];

    expect(clientExport).toEqual({
      types: "./src/client/runtime/index.ts",
      import: "./src/client/runtime/index.ts",
      default: "./src/client/runtime/index.ts",
    });
    const allExportTargets = Object.values(packageJson.exports).flatMap(
      (packageExport) => Object.values(packageExport),
    );

    expect(allExportTargets).not.toContain("./src/hydration/index.ts");
  });

  it("resolves the public client subpath", async () => {
    const runtime = await import("@warlock.js/web/client/runtime");

    expect(typeof runtime.validateClientRouteManifest).toBe("function");
    expect(typeof runtime.loadClientRouteComposition).toBe("function");
  });
});
