/**
 * Per-request stylesheets — CSS that belongs to THIS response only.
 *
 * A handler's stylesheet chain (`[root, ...layouts, page]`) is fixed when the
 * route is installed. A module the page imports lazily and picks per request
 * — a tenant's theme component chosen from a static `import()` map — is not
 * in that chain, and the server cannot observe which lazy module actually
 * rendered. Without a declaration its CSS only arrives from client JavaScript,
 * after the server-rendered document has already painted unstyled.
 *
 * Middleware (or a loader) that picks the module declares its SOURCE id here;
 * the render stage resolves it to render-blocking `<link>` tags through the
 * Vite manifest in production and the module graph in development.
 *
 * Client-safe on purpose: no Node or framework imports, just a WeakMap keyed
 * by the request object, so the barrel stays importable from `root.tsx` and
 * every entry is collected with its request.
 */

const declaredSources = new WeakMap<object, string[]>();

/**
 * Raised when a declared source id is not an app-root-relative POSIX module
 * path — the identity the Vite manifest and the page manifest key modules by.
 */
export class InvalidStylesheetSourceError extends Error {
  public constructor(
    public readonly sourceFile: string,
    reason: string,
  ) {
    super(
      `linkStylesheetsFor() received ${JSON.stringify(sourceFile)}: ${reason}. Pass the module's ` +
        'app-root-relative source path, e.g. "src/web/themes/alpha/alpha-theme.tsx".',
    );
    this.name = "InvalidStylesheetSourceError";
  }
}

/** Returns why `sourceFile` is not a valid source id, or `undefined` when it is. */
function invalidReason(sourceFile: string): string | undefined {
  if (sourceFile === "") return "it is empty";
  if (sourceFile.includes("\\")) return "it contains a backslash; use forward slashes";
  if (sourceFile.startsWith("/") || /^[A-Za-z]:/.test(sourceFile)) return "it is an absolute path";
  if (sourceFile.startsWith("./")) return 'it starts with "./"; ids are relative to the app root';
  if (sourceFile.split("/").includes("..")) return 'it contains a ".." segment';
  if (sourceFile.includes("?") || sourceFile.includes("#")) return "it carries a query or hash";

  return undefined;
}

/**
 * Link the CSS of `sourceFile` — and the CSS its static imports pull in — into
 * this request's document `<head>`, after the route's own stylesheets.
 *
 * Call it from middleware or a loader, before render. Duplicates collapse;
 * order of first declaration is kept.
 *
 * @example
 * const selectTheme = async ({ request }: HttpContext) => {
 *   shared.theme = themeForHost(request.header("host"));
 *   linkStylesheetsFor(request, themeSources[shared.theme]);
 * };
 */
export function linkStylesheetsFor(request: object, sourceFile: string): void {
  const reason = invalidReason(sourceFile);

  if (reason !== undefined) {
    throw new InvalidStylesheetSourceError(sourceFile, reason);
  }

  const sources = declaredSources.get(request);

  if (sources === undefined) {
    declaredSources.set(request, [sourceFile]);
  } else if (!sources.includes(sourceFile)) {
    sources.push(sourceFile);
  }
}

/** The source ids `request` declared through {@link linkStylesheetsFor}, in declaration order. */
export function requestStylesheetSources(request: object): readonly string[] {
  return declaredSources.get(request) ?? [];
}
