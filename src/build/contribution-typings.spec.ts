import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConnectorBuildContext } from "@warlock.js/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebBuildContribution } from "./contribution";

/*
  `warlock generate.typings` must write `.warlock/typings/web-routes.d.ts` from
  the SAME writer and inputs the build contribution uses, so a clean checkout can
  typecheck before `warlock build` has ever run.
*/

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeApp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-web-typings-"));
  roots.push(root);

  const files: Record<string, string> = {
    "src/web/root.tsx": "export default function App() { return null; }\n",
    "src/web/home.page.tsx":
      'export const config = { route: "/" };\nexport default function Page() { return null; }\n',
    "src/web/site/page.page.tsx":
      'export const config = { route: "/site/page" };\nexport default function Page() { return null; }\n',
  };

  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  return root;
}

function context(appRoot: string): ConnectorBuildContext {
  return {
    appRoot,
    productionDir: path.join(appRoot, ".warlock", "production"),
    options: { outdir: path.join(appRoot, "dist") } as ConnectorBuildContext["options"],
    namedApiRoutes: [{ name: "users.list", path: "/api/users", method: "GET" }],
  };
}

const TYPES = ".warlock/typings/web-routes.d.ts";

describe("web build contribution — typings hook", () => {
  it("writes web-routes.d.ts with the same content the build contribution writes", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const built = makeApp();
    const typed = makeApp();

    await createWebBuildContribution({ sites: undefined }).generate?.(context(built));
    await createWebBuildContribution().typings?.(context(typed));
    log.mockRestore();

    const expected = fs.readFileSync(path.join(built, TYPES), "utf-8");

    expect(expected).toContain("/site/page");
    expect(fs.readFileSync(path.join(typed, TYPES), "utf-8")).toBe(expected);
  }, 30_000);

  it("does not write the page barrel or any other build artifact", async () => {
    const appRoot = makeApp();

    await createWebBuildContribution().typings?.(context(appRoot));

    expect(fs.existsSync(path.join(appRoot, ".warlock", "production"))).toBe(false);
  });
});
