import { cssModuleClassName } from "../build/css-module-class-name";

/**
 * Vite's `css` block: scoped names come from the same function the server
 * bundle uses, rooted at the project root, so SSR and client class names match.
 */
export function cssModulesConfig(root: string) {
  return {
    modules: {
      generateScopedName: (name: string, filename: string) =>
        cssModuleClassName(name, filename, root),
    },
  };
}
