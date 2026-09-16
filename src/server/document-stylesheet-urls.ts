/**
 * Resolves the source ids one request declared through `linkStylesheetsFor()`
 * into stylesheet URLs. Supplied by the route installer, which owns the
 * dev/prod split (module graph vs. Vite manifest).
 */
export type RequestStylesheetUrlResolver = (sourceFiles: readonly string[]) => readonly string[];

/**
 * The document's final stylesheet list: the handler's static chain, then the
 * CSS of whatever this request declared, deduped with first position kept.
 *
 * The resolver is not called when nothing was declared, so a route that
 * never uses per-request stylesheets pays nothing. Declarations with no
 * resolver (a caller that never wired one) are ignored rather than guessed.
 */
export function documentStylesheetUrls(
  handlerUrls: readonly string[] | undefined,
  declaredSources: readonly string[],
  resolve: RequestStylesheetUrlResolver | undefined,
): readonly string[] | undefined {
  if (declaredSources.length === 0 || resolve === undefined) return handlerUrls;

  const urls = [...(handlerUrls ?? [])];

  for (const url of resolve(declaredSources)) {
    if (!urls.includes(url)) urls.push(url);
  }

  return urls;
}
