import fs from "node:fs";
import { pageSetupFileFor } from "./page-setup-file";
import {
  mergeModuleConfigReads,
  readModuleConfig,
  type ModuleConfigRead,
} from "./read-module-config";

type GuardedModuleKind = "page" | "layout" | "root";

function readComposed(file: string, kind: GuardedModuleKind): ModuleConfigRead {
  const read = (sourceFile: string) =>
    readModuleConfig(sourceFile, fs.readFileSync(sourceFile, "utf-8"), kind, {
      allowMissingDefault: true,
    });
  const setupCandidate = pageSetupFileFor(file);
  const setupFile =
    setupCandidate !== undefined && fs.existsSync(setupCandidate) ? setupCandidate : undefined;

  return mergeModuleConfigReads(
    file,
    read(file),
    setupFile,
    setupFile === undefined ? undefined : read(setupFile),
  );
}

/**
 * The static guard of one routable page, for callers that do not run full discovery (the dev
 * installer): `"user"` when the page, a layout on its chain, or the application root declares
 * `requireUser(...)` as a direct element of a literal `config.middleware` array. The same rule
 * {@link discoverPages} applies, read through the same module-config reader.
 *
 * Never throws: a file that cannot be read statically reads as unguarded, so a half-edited module
 * cannot break dev boot over a type-only fact.
 */
export function readPageGuard(input: {
  pageFile: string;
  layouts: readonly string[];
  appFile?: string;
}): "user" | undefined {
  const candidates: Array<[string, GuardedModuleKind]> = [
    ...(input.appFile === undefined ? [] : [[input.appFile, "root"] as [string, GuardedModuleKind]]),
    ...input.layouts.map((layout): [string, GuardedModuleKind] => [layout, "layout"]),
    [input.pageFile, "page"],
  ];

  for (const [file, kind] of candidates) {
    try {
      if (readComposed(file, kind).guardsUser === true) return "user";
    } catch {
      // Unreadable here means "not provably guarded"; the real loader reports the error.
    }
  }

  return undefined;
}
