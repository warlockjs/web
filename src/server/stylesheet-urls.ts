/**
 * Which stylesheets a REGISTERED HANDLER must link, in each of the two modes.
 *
 * WHY THIS EXISTS AT ALL. Nothing used to put CSS into the server-rendered
 * document. A stylesheet reached the browser only because the CLIENT bundle
 * imported it, which means JavaScript applied it after the module graph
 * loaded — so every full page load painted unstyled first and restyled a
 * moment later. The markup was correct the whole time, which is precisely why
 * it was easy to miss.
 *
 * THE SCOPE IS PER HANDLER, NOT PER APPLICATION. Every page renders inside
 * `[root, ...outer-to-inner matched layouts, page]` — that is the exact triple
 * (widened to a chain) `create-page-route-handler.ts` loads per request — so a
 * handler's CSS is the ordered, deduped union of what those specific source
 * files pull in, and nothing else. Collecting across the WHOLE application
 * (every page's manifest entry, every root import) is the bug this shape
 * exists to avoid: it ships page B's stylesheet on page A's response, and it
 * only gets worse as an application grows.
 *
 * The two modes learn the answer from different places, and neither can use
 * the other's:
 *
 *  - PRODUCTION reads Vite's client manifest, matching each source file's own
 *    id and walking its recorded `css` and imported chunks.
 *  - DEV has no manifest — Vite serves modules on demand — so the URLs are
 *    derived from each source file's own import statements.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { CLIENT_ASSET_URL_PREFIX } from "./client-asset-url-prefix";

/** Stylesheet extensions Vite can serve directly. Mirrors the build's list. */
const STYLE_EXTENSIONS = [".css", ".scss", ".sass", ".less", ".styl"];

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

/**
 * ONE source file's own directly imported stylesheets, as dev URLs.
 *
 * Dev has no manifest, so the source is the file itself: whatever it imports
 * with a stylesheet extension is what it needs. This is deliberately narrow —
 * it answers "what CSS does THIS file set up", not "what CSS does the whole
 * module graph this file eventually reaches end up pulling in" — because the
 * latter would require reproducing Vite's module graph, which is precisely
 * what dev has no manifest to shortcut.
 *
 * The narrowness is the honest part: production splits CSS per chunk and can
 * follow imported chunks (`productionStylesheetUrls` below); dev can only read
 * the ONE file handed to it. A page whose own module imports its own
 * stylesheet still gets it in dev — Vite's client graph injects it as before —
 * it simply is not render-blocking the way a chain member's own import is.
 *
 * Called once per chain member — root, then every matched layout outer to
 * inner, then the page — by the installers below, which is what turns "one
 * file's own imports" into a handler's whole CSS chain.
 *
 * Specifiers are resolved against `sourceFile` and expressed relative to
 * `appRoot`, because that is the shape Vite's dev server serves from.
 */
export function devStylesheetUrls(appRoot: string, sourceFile: string): string[] {
  let source: string;

  try {
    source = readFileSync(sourceFile, "utf-8");
  } catch {
    return [];
  }

  const urls: string[] = [];
  const pattern = /\bimport\s*(?:\(\s*)?["']([^"']+)["']/g;

  let match = pattern.exec(source);

  while (match !== null) {
    const specifier = match[1];
    const lowered = specifier.toLowerCase();

    if (STYLE_EXTENSIONS.some((extension) => lowered.endsWith(extension))) {
      const absolute = path.resolve(path.dirname(sourceFile), specifier);
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
 * ONE handler's whole dev CSS chain: every `sourceFiles` member's own direct
 * stylesheet imports (`devStylesheetUrls`), in the order given — the caller
 * passes `[root, ...outer-to-inner matched layouts, page]` — concatenated and
 * deduped across the WHOLE chain, not just within one file.
 *
 * Cross-file dedup matters as much as within-file dedup: an application-wide
 * `app.css` imported by both the root and a page must still produce one
 * `<link>`, not two.
 */
export function devHandlerStylesheetUrls(
  appRoot: string,
  sourceFiles: readonly string[],
): string[] {
  const urls: string[] = [];

  for (const sourceFile of sourceFiles) {
    for (const url of devStylesheetUrls(appRoot, sourceFile)) {
      if (!urls.includes(url)) urls.push(url);
    }
  }

  return urls;
}

type ManifestEntry = {
  css?: unknown;
  imports?: unknown;
};

/**
 * Find the manifest key for an app-root-relative POSIX source id.
 *
 * VITE KEYS BY SOURCE PATH RELATIVE TO ITS OWN `root`, not to the app's
 * `appRoot` — the client build's `root` is the framework's own package
 * (`build-client.ts`), so a key for an app source file carries a `../`-laden
 * prefix (`"../my-app/src/web/root.tsx"`) rather than matching `sourceFile`
 * (`"src/web/root.tsx"`) byte for byte. The two forms always share the same
 * TAIL, though — both are anchored at the same file — so an exact match is
 * tried first (the case where the client build's root IS the app root, which
 * every fixture and every test below uses) and a `/`-boundary suffix match
 * second, rather than trying to reconstruct the build's own root here, which
 * this runtime read has no way to independently confirm.
 */
function findManifestKey(
  manifest: Record<string, ManifestEntry | undefined>,
  sourceFile: string,
): string | undefined {
  if (manifest[sourceFile] !== undefined) return sourceFile;

  const suffix = `/${sourceFile}`;

  for (const key of Object.keys(manifest)) {
    if (key.endsWith(suffix)) return key;
  }

  return undefined;
}

/**
 * Every stylesheet reachable from ONE manifest entry: its own recorded `css`,
 * plus the same walk repeated over every chunk it STATICALLY `imports`.
 *
 * `imports` only, never `dynamicImports`. Vite's manifest records
 * `dynamicImports` on shared entry points (the hydration entry names every
 * page as one) precisely because the browser must NOT download them eagerly —
 * walking that array here would pull every other page's CSS onto this one,
 * which is the exact "unrelated pages" leak this module exists to end.
 * `imports`, by contrast, are chunks THIS module synchronously depends on:
 * code Vite split out of it but that loads whenever it does, so their CSS is
 * this handler's CSS too.
 *
 * `visited` guards against a chunk graph cycle; sharing one set across the
 * whole walk from a single entry is enough; a shared chunk revisited from a
 * SEPARATE top-level entry (root vs. a layout vs. the page) is deliberately
 * walked again — the final merge in `productionStylesheetUrls` dedupes by URL,
 * and a fresh `visited` set per entry is simpler to reason about than one
 * threaded across unrelated chains.
 */
function collectManifestCss(
  manifest: Record<string, ManifestEntry | undefined>,
  key: string,
  visited: Set<string>,
): string[] {
  if (visited.has(key)) return [];
  visited.add(key);

  const entry = manifest[key];
  if (entry === undefined) return [];

  const ownCss = Array.isArray(entry.css)
    ? entry.css.filter((file): file is string => typeof file === "string" && file !== "")
    : [];

  const imports = Array.isArray(entry.imports)
    ? entry.imports.filter((id): id is string => typeof id === "string")
    : [];

  return [
    ...ownCss,
    ...imports.flatMap((importedKey) => collectManifestCss(manifest, importedKey, visited)),
  ];
}

/**
 * ONE handler's whole production CSS chain.
 *
 * `sourceFiles` is `[root, ...outer-to-inner matched layouts, page]`, each an
 * app-root-relative POSIX source id — the SAME id
 * `install-page-routes-from-manifest.ts` already carries as `sourceFile` on
 * every manifest entry, because that identity is what lets this function match
 * EXPLICITLY rather than guess: every id is looked up on its own
 * (`findManifestKey`), its own chunk's CSS is collected
 * (`collectManifestCss`), and an id with no matching entry contributes
 * nothing — it is never treated as license to fall back to scanning the whole
 * manifest, which is what let an unrelated page's CSS leak onto this handler
 * before.
 *
 * Duplicates are collapsed and order is preserved across the WHOLE chain, in
 * the order `sourceFiles` was given — root's own CSS first, then each
 * layout's outer to inner, then the page's — so cascade order matches the
 * chain's own outer-to-inner rendering order.
 *
 * A missing or malformed manifest returns NOTHING rather than throwing. The
 * hydration resolver already fails loudly on exactly those conditions, from
 * exactly the same file, and it runs first — a second, worse error for the
 * same cause helps nobody.
 */
export function productionStylesheetUrls(
  clientDir: string,
  sourceFiles: readonly string[],
): string[] {
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

  const files: string[] = [];

  for (const sourceFile of sourceFiles) {
    const key = findManifestKey(manifest, sourceFile);
    if (key === undefined) continue;

    files.push(...collectManifestCss(manifest, key, new Set()));
  }

  const urls: string[] = [];

  for (const file of files) {
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

  return urls;
}
