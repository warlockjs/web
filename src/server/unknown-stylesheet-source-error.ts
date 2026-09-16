/**
 * Raised when a source id declared through `linkStylesheetsFor()` does not
 * name a module the build knows — no Vite manifest entry in production, no
 * file in development. A silent skip would ship the page unstyled on first
 * paint with nothing in the logs, so the render fails loudly instead.
 */
export class UnknownStylesheetSourceError extends Error {
  public constructor(
    public readonly sourceFile: string,
    mode: "development" | "production",
  ) {
    super(
      mode === "production"
        ? `linkStylesheetsFor() declared "${sourceFile}", but the client build manifest has no entry ` +
            "for it. Declare the exact app-root-relative path of a module the client imports " +
            '(for a theme map, the file inside `import("./themes/...")`), then rebuild.'
        : `linkStylesheetsFor() declared "${sourceFile}", but no such file exists under the app root. ` +
            'Declare the exact app-root-relative path, e.g. "src/web/themes/alpha/alpha-theme.tsx".',
    );
    this.name = "UnknownStylesheetSourceError";
  }
}
