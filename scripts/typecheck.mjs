// Runs every TypeScript program web must keep green, in order, and exits
// non-zero on the first failure. One entry file because the release gate
// executes package scripts without a shell, so `a && b` is not available.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
const projects = [
  "tsconfig.typecheck.json",
  "__tests__/types/tsconfig.with-generation.json",
  "__tests__/types/tsconfig.without-generation.json",
];

for (const project of projects) {
  const result = spawnSync(process.execPath, [tsc, "-p", project], { cwd: root, stdio: "inherit" });

  if (result.status !== 0) {
    console.error(`typecheck failed: ${project}`);
    process.exit(result.status ?? 1);
  }
}
