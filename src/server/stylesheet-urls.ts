/**
 * Which stylesheets a document must link, in each of the two modes.
 *
 * WHY THIS EXISTS AT ALL. Nothing used to put CSS into the server-rendered
 * document. A stylesheet reached the browser only because the CLIENT bundle
 * imported it, which means JavaScript applied it after the module graph
 * loaded — so every full page load painted unstyled first and restyled a
 * moment later. The markup was correct the whole time, which is precisely why
 * it was easy to miss.
 *
 * The two modes learn the answer from different places, and neither can use
 * the other's:
 *
 *  - PRODUCTION reads Vite's client manifest, the same artifact the hydration
 *    entry is already resolved from.
 *  - DEV has no manifest — Vite serves modules on demand — so the URLs are
 *    derived from the source files themselves.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { CLIENT_ASSET_URL_PREFIX } from "./client-asset-url-prefix";

/** Stylesheet extensions Vite can serve directly. Mirrors the build's list. */
const STYLE_EXTENSIONS = [".css", ".scss", ".sass", ".less", ".styl"];

/**
 * The stylesheets the ROOT document imports, as dev URLs.
 *
 * Dev has no manifest, so the source is the root file itself: whatever
 * `root.tsx` imports with a stylesheet extension is what the document needs.
 * That is deliberately narrow — it answers "what CSS does this application
 * set up globally", which is where `app.css` lives and where Tailwind is
 * wired, and it does NOT try to reproduce Vite's per-route CSS graph.
 *
 * The narrowness is the honest part: production splits CSS per chunk, dev
 * links the root's stylesheets on every page. A page whose own module imports
 * its own stylesheet still gets it in dev — Vite's client graph injects it as
 * before — it simply is not render-blocking the way the root's is. That is a
 * smaller gap than the flash this removes, and it is stated rather than
 * hidden.
 *
 * Specifiers are resolved against the root file and expressed relative to the
 * app root, because that is the shape Vite's dev server serves from.
 */
export function devStylesheetUrls(appRoot: string, appFile: string): string[] {
  let source: string;

  try {
    source = readFileSync(appFile, "utf-8");
  } catch {
    return [];
  }

  const urls: string[] = [];
  const pattern = /\bimport\s*["']([^"']+)["']/g;

  let match = pattern.exec(source);

  while (match !== null) {
    const specifier = match[1];
    const lowered = specifier.toLowerCase();

    if (STYLE_EXTENSIONS.some((extension) => lowered.endsWith(extension))) {
      const absolute = path.resolve(path.dirname(appFile), specifier);
      const relative = path.relative(appRoot, absolute).split(path.sep).join("/");

      // Outside the app root Vite would need an `/@fs/` URL and a widened
      // `fs.allow`; a stylesheet living there is unusual enough that guessing
      // is worse than leaving it to the client import.
      if (!relative.startsWith("..")) {
        const url = `/${relative}${VITE_DIRECT_CSS_QUERY}`;

        if (!urls.includes(url)) urls.push(url);
      }
    }

    match = pattern.exec(source);
  }

  return urls;
}

/**
 * A stylesheet Vite serves in DEV must be requested with `?direct`.
 *
 * Without it Vite answers the same URL with `text/javascript` — its CSS-as-JS
 * module transform, meant for `import "./app.css"` — and a
 * `<link rel="stylesheet">` pointing at a JavaScript response applies
 * NOTHING, silently. No console error, no network failure, just an unstyled
 * page. `?direct` is what makes Vite reply with real `text/css`.
 */
export const VITE_DIRECT_CSS_QUERY = "?direct";

type ManifestEntry = {
  css?: unknown;
  file?: unknown;
};

/**
 * Every stylesheet the client build emitted, as URLs the asset route serves.
 *
 * Vite records CSS against the CHUNK that imported it — an app whose
 * `root.tsx` imports `app.css` produces a `root.tsx` entry carrying
 * `css: ["assets/root-<hash>.css"]`, not a hydration entry carrying it. So
 * this collects across every entry rather than looking under one name, which
 * would silently find nothing the moment a stylesheet moved file.
 *
 * Duplicates are collapsed and order is preserved: two chunks importing the
 * same stylesheet must not emit two `<link>` tags.
 *
 * A missing or malformed manifest returns NOTHING rather than throwing. The
 * hydration resolver already fails loudly on exactly those conditions, from
 * exactly the same file, and it runs first — a second, worse error for the
 * same cause helps nobody.
 */
export function productionStylesheetUrls(clientDir: string): string[] {
  const manifestPath = path.join(clientDir, ".vite", "manifest.json");

  let manifest: Record<string, ManifestEntry | undefined>;

  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as Record<
      string,
      ManifestEntry | undefined
    >;
  } catch {
    return [];
  }

  if (typeof manifest !== "object" || manifest === null) return [];

  const urls: string[] = [];

  for (const entry of Object.values(manifest)) {
    if (entry === undefined || !Array.isArray(entry.css)) continue;

    for (const file of entry.css) {
      if (typeof file !== "string" || file === "") continue;

      // Built EXACTLY as the hydration entry's URL is built — `/${file}`, then
      // checked against the prefix — rather than reassembled from a basename.
      // The manifest already records `assets/root-<hash>.css`, and rebuilding
      // that path here would be a second expression of a convention
      // `client-asset-url-prefix.ts` owns.
      const url = `/${file}`;

      // A stylesheet outside the directory the asset route mounts would 404.
      // Dropped rather than emitted, because a dead <link> in <head> is a
      // silent styling failure — the exact thing this module exists to end.
      if (!url.startsWith(`${CLIENT_ASSET_URL_PREFIX}/`)) continue;

      if (!urls.includes(url)) urls.push(url);
    }
  }

  return urls;
}
