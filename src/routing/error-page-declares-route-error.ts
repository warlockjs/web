/** Raised when an error boundary attempts to become a browsable route. */
export class ErrorPageDeclaresRouteError extends Error {
  public constructor(pageFile: string) {
    super(
      `The error page "${pageFile}" declares \`config.route\`. error.page.tsx is an error boundary, not a browsable page; remove config.route.`,
    );
    this.name = "ErrorPageDeclaresRouteError";
  }
}
