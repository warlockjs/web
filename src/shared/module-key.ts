import { toPosix } from "./to-posix";

/**
 * Rollup/Vite module ids carry query suffixes (`?v=`, `?used`, ...) that differ
 * between a `transform` id and a later `importer`, and carry `\`-separated
 * paths on Windows. Both sides key through here so they agree.
 */
export function moduleKey(id: string): string {
  return toPosix(id.split("?")[0]);
}
