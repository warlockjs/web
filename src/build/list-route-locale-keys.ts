import fs from "node:fs";
import path from "node:path";
import { discoverPageFileGraph } from "./discover-pages";
import { parseRouteLocaleFile } from "./parse-route-locales";
import { assertRouteLocaleKeyOwnership } from "./route-locale-key-ownership";

export type ListRouteLocaleKeysOptions = {
  appRoot?: string;
  /** Source directory beneath appRoot, or an absolute source directory. */
  srcDir?: string;
};

/**
 * Lists the complete JSON translation-key union without evaluating application
 * modules or configuration. Runtime locale coverage is checked by the installer.
 */
export function listRouteLocaleKeys(options: ListRouteLocaleKeysOptions = {}): string[] {
  const appRoot = options.appRoot ?? process.cwd();
  const graph = discoverPageFileGraph(path.resolve(appRoot, options.srcDir ?? "src"));
  const parsed = graph.localeFiles.map((file) =>
    parseRouteLocaleFile({ ...file, source: fs.readFileSync(file.sourceFile, "utf-8") }),
  );
  return assertRouteLocaleKeyOwnership(parsed);
}
