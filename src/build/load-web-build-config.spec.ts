import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWebBuildConfig } from "./load-web-build-config";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("loadWebBuildConfig", () => {
  it("reads web.sites while retaining only the static build shape", async () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-web-build-config-"));
    roots.push(appRoot);
    const configDir = path.join(appRoot, "src", "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "web.ts"),
      [
        "export default {",
        '  sites: { landing: { pages: "(landing)", hosts: ["estates.test"], basePath: "/", localeRouting: { strategy: "prefix" } } },',
        "  resolveHost() { return null; },",
        "};",
      ].join("\n"),
      "utf8",
    );

    const config = await loadWebBuildConfig(appRoot);

    expect(config).toEqual({
      sites: {
        landing: {
          pages: "(landing)",
          hosts: ["estates.test"],
          basePath: "/",
          localeRouting: { strategy: "prefix" },
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain("resolveHost");
  });

  it("resolves the app's tsconfig path aliases in web.ts (a resolver imported from app/*)", async () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-web-build-config-"));
    roots.push(appRoot);
    fs.mkdirSync(path.join(appRoot, "src", "config"), { recursive: true });
    fs.mkdirSync(path.join(appRoot, "src", "app", "tenants"), { recursive: true });
    fs.writeFileSync(
      path.join(appRoot, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: "src", paths: { "app/*": ["app/*"] } } }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(appRoot, "src", "app", "tenants", "resolve-host.ts"),
      "export const tenantHosts: string[] = [\"acme.test\"];\nexport const resolveHost = () => null;\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(appRoot, "src", "config", "web.ts"),
      [
        'import { resolveHost, tenantHosts } from "app/tenants/resolve-host";',
        "export default {",
        '  sites: { tenant: { pages: "(tenant)", hosts: tenantHosts } },',
        "  resolveHost,",
        "};",
      ].join("\n"),
      "utf8",
    );

    const config = await loadWebBuildConfig(appRoot);

    expect(config).toEqual({ sites: { tenant: { pages: "(tenant)", hosts: ["acme.test"] } } });
    expect(fs.readdirSync(appRoot).filter((name) => name.endsWith(".mjs"))).toEqual([]);
  });
});
