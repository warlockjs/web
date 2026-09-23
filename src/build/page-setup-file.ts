import path from "node:path";

const PAGE_FILE_SUFFIX = ".page.tsx";
const SETUP_FILE_SUFFIX = ".setup.ts";

/**
 * The optional server/setup companion for a supported Web UI module.
 *
 * This is a name transformation only. Discovery owns the filesystem check so
 * every consumer can share the exact pairing rule without performing an
 * accidental second scan.
 */
export function pageSetupFileFor(moduleFile: string): string | undefined {
  const base = path.basename(moduleFile);

  if (base.endsWith(PAGE_FILE_SUFFIX)) {
    return path.join(path.dirname(moduleFile), `${base.slice(0, -PAGE_FILE_SUFFIX.length)}${SETUP_FILE_SUFFIX}`);
  }

  if (base === "layout.tsx" || base === "root.tsx") {
    return path.join(path.dirname(moduleFile), `${base.slice(0, -".tsx".length)}${SETUP_FILE_SUFFIX}`);
  }

  return undefined;
}

/** The UI owner of a setup filename, when its name follows the pairing convention. */
export function pageSetupOwnerFileFor(setupFile: string): string | undefined {
  const base = path.basename(setupFile);
  if (!base.endsWith(SETUP_FILE_SUFFIX)) return undefined;

  const stem = base.slice(0, -SETUP_FILE_SUFFIX.length);
  if (stem === "root" || stem === "layout") return path.join(path.dirname(setupFile), `${stem}.tsx`);
  return path.join(path.dirname(setupFile), `${stem}${PAGE_FILE_SUFFIX}`);
}
