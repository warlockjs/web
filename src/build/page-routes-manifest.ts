import fs from "node:fs";
import path from "node:path";
import type { PageRoutesManifest } from "./generate-pages-barrel";

export const PAGE_ROUTES_MANIFEST_FILE = "page-routes.manifest.json";

/** Atomically replace the snapshot only after the rest of the build succeeds. */
export async function writePageRoutesManifest(
  outdir: string,
  manifest: PageRoutesManifest,
): Promise<void> {
  const target = path.join(outdir, PAGE_ROUTES_MANIFEST_FILE);
  const temporary = path.join(
    outdir,
    `.${PAGE_ROUTES_MANIFEST_FILE}.${process.pid}.${Date.now()}.tmp`,
  );

  await fs.promises.mkdir(outdir, { recursive: true });

  try {
    await fs.promises.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    await fs.promises.rename(temporary, target);
  } finally {
    await fs.promises.unlink(temporary).catch(() => {});
  }
}
