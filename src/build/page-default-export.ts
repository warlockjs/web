import { parse } from "@babel/parser";

/** Raised when a `*.page.tsx` module cannot render a page component. */
export class MissingPageDefaultExportError extends Error {
  public constructor(public readonly pageFile: string) {
    super(
      `The page "${pageFile}" has no runtime default export. Every \`*.page.tsx\` file must ` +
        "default-export the React component it renders. For example: " +
        "`export default function Page() { return <main />; }`",
    );
    this.name = "MissingPageDefaultExportError";
  }
}

/**
 * Refuses a page that only has named or type exports.
 *
 * This is static on purpose: discovery runs in both the dev registry and the
 * production barrel generator, before either consumer imports application
 * code. Re-exporting a runtime binding as `default` is valid ES module syntax
 * and therefore satisfies the same contract as `export default`.
 */
export function assertPageHasDefaultExport(pageFile: string, source: string): void {
  let program: ReturnType<typeof parse>["program"];

  try {
    program = parse(source, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
      errorRecovery: false,
    }).program;
  } catch (error) {
    throw new Error(
      `Cannot inspect the default export of "${pageFile}": the file could not be parsed ` +
        `(${(error as Error).message}). Fix the syntax error and discovery will continue.`,
    );
  }

  for (const statement of program.body) {
    if (statement.type === "ExportDefaultDeclaration") {
      // `export default interface Page {}` is erased by TypeScript and leaves
      // no runtime component for either SSR or hydration to render.
      if ((statement.declaration as { type: string }).type !== "TSInterfaceDeclaration") return;
      continue;
    }

    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;

    for (const specifier of statement.specifiers) {
      if (
        !("exported" in specifier) ||
        (specifier.type === "ExportSpecifier" && specifier.exportKind === "type")
      ) {
        continue;
      }

      const exported =
        specifier.exported.type === "Identifier"
          ? specifier.exported.name
          : specifier.exported.value;

      if (exported === "default") return;
    }
  }

  throw new MissingPageDefaultExportError(pageFile);
}
