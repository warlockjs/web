import { createHash } from "node:crypto";
import path from "node:path";

/**
 * The one scoped class name for a CSS Module selector, shared by the client
 * (Vite `css.modules.generateScopedName`) and the server (esbuild plugin).
 *
 * Deterministic and independent of the CSS content, so the two bundles cannot
 * drift: the hash covers only the root-relative POSIX file path and the local
 * name.
 */
export function cssModuleClassName(localName: string, filePath: string, root: string): string {
  const relative = path.relative(root, filePath).split(path.sep).join("/");
  const hash = createHash("sha256").update(`${relative}:${localName}`).digest("hex").slice(0, 6);

  return `${localName}_${hash}`;
}
