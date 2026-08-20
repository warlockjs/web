// Transitively pulls in a Node builtin — the page never imports "fs" directly.
import { readFileSync } from "node:fs";

export function readConfig(path: string) {
  return readFileSync(path, "utf-8");
}
