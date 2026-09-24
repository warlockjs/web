import path from "node:path";
import { describe, expect, it } from "vitest";
import { cssModulesConfig } from "../vite/css-modules-config";
import { cssModuleClassName } from "./css-module-class-name";
import { cssModuleServerSource } from "./css-module-esbuild-plugin";

const root = path.resolve("/app");
const file = path.join(root, "src", "web", "card.module.css");
const css = `/* .fake { } */
.card { background: url(".notaclass.png"); margin: 1.5em; }
.card-title { color: red; }
:global(.x) { color: blue; }
`;

describe("css modules SSR class names", () => {
  it("maps each local to cssModuleClassName and skips comments and :global", () => {
    const map = JSON.parse(
      cssModuleServerSource(css, file, root).replace(/^export default /, "").replace(/;$/, ""),
    );

    expect(map).toEqual({
      card: cssModuleClassName("card", file, root),
      "card-title": cssModuleClassName("card-title", file, root),
    });
    expect(map).not.toHaveProperty("fake");
    expect(map).not.toHaveProperty("x");
  });

  it("throws on composes", () => {
    expect(() => cssModuleServerSource(".a { composes: b from './c.css'; }", file, root)).toThrow(
      /composes/,
    );
  });

  it("is stable and path-relative", () => {
    expect(cssModuleClassName("card", file, root)).toMatch(/^card_[0-9a-f]{6}$/);
    expect(cssModuleClassName("card", file, root)).toBe(cssModuleClassName("card", file, root));
  });

  it("the Vite generateScopedName returns the same string", () => {
    const generate = cssModulesConfig(root).modules.generateScopedName;

    expect(generate("card", file)).toBe(cssModuleClassName("card", file, root));
  });
});
