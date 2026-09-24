import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import esbuild from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { cssModuleClassName } from "./css-module-class-name";
import { cssModulesServerPlugin } from "./css-module-esbuild-plugin";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("CSS Modules in the SSR bundle", () => {
  it("bundles ./x.module.css to the class map the client build generates", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-cssm-"));
    temps.push(root);

    const cssFile = path.join(root, "src", "x.module.css");
    fs.mkdirSync(path.dirname(cssFile), { recursive: true });
    fs.writeFileSync(cssFile, ".card { color: red; }\n.card-title { margin: 1.5em; }\n");
    fs.writeFileSync(
      path.join(root, "src", "page.js"),
      'import styles from "./x.module.css";\nexport default styles;\n',
    );

    const result = await esbuild.build({
      entryPoints: [path.join(root, "src", "page.js")],
      bundle: true,
      write: false,
      format: "esm",
      loader: { ".css": "empty" },
      plugins: [cssModulesServerPlugin(root)],
    });

    const code = result.outputFiles[0]!.text;
    const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
    const { default: map } = await import(/* @vite-ignore */ dataUrl);

    expect(map).toEqual({
      card: cssModuleClassName("card", cssFile, root),
      "card-title": cssModuleClassName("card-title", cssFile, root),
    });
  });
});
