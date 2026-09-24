import fs from "node:fs";
import type { Plugin } from "esbuild";
import { cssModuleClassName } from "./css-module-class-name";

/**
 * Blank comments, strings and `url(...)` bodies, preserving offsets, so the
 * selector scan only sees real selectors.
 */
function blankNonSelectors(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (m) => " ".repeat(m.length))
    .replace(/url\([^)]*\)/gi, (m) => " ".repeat(m.length));
}

/** Removes `:global(...)` (balanced) and bare `:global` selectors' names. */
function withoutGlobals(css: string): string {
  let out = "";
  let index = 0;

  while (index < css.length) {
    if (css.startsWith(":global(", index)) {
      let depth = 1;
      let cursor = index + ":global(".length;

      while (cursor < css.length && depth > 0) {
        if (css[cursor] === "(") depth++;
        if (css[cursor] === ")") depth--;
        cursor++;
      }

      out += " ".repeat(cursor - index);
      index = cursor;
      continue;
    }

    out += css[index];
    index++;
  }

  return out;
}

/** The local class names a CSS Module declares, in first-seen order. */
export function collectCssModuleClasses(source: string, file = "<css>"): string[] {
  const css = blankNonSelectors(source);

  if (/\bcomposes\s*:/.test(css)) {
    throw new Error(
      `Cannot build "${file}": \`composes:\` in CSS Modules is not supported in SSR yet. ` +
        "Inline the shared declarations or apply both class names in the component.",
    );
  }

  const names = new Set<string>();
  const pattern = /\.(-?[_a-zA-Z][\w-]*)/g;
  // Only text before a `{` is a selector; declaration bodies hold values like `1.5em`.
  const selectors = withoutGlobals(css).replace(/\{[^{}]*\}/g, "{}");
  let match = pattern.exec(selectors);

  while (match !== null) {
    const name = match[1];

    if (name !== undefined) names.add(name);

    match = pattern.exec(selectors);
  }

  return [...names];
}

/** The JS module a `*.module.css` compiles to in the server bundle. */
export function cssModuleServerSource(source: string, file: string, root: string): string {
  const map: Record<string, string> = {};

  for (const local of collectCssModuleClasses(source, file)) {
    map[local] = cssModuleClassName(local, file, root);
  }

  return `export default ${JSON.stringify(map)};`;
}

/** esbuild plugin: `*.module.css` -> the same class map the client build emits. */
export function cssModulesServerPlugin(root: string): Plugin {
  return {
    name: "warlock-css-modules-ssr",
    setup(build) {
      build.onLoad({ filter: /\.module\.css$/ }, async (args) => ({
        contents: cssModuleServerSource(await fs.promises.readFile(args.path, "utf-8"), args.path, root),
        loader: "js",
      }));
    },
  };
}
