/**
 * Thrown by the loader form of `requireUser(ctx)` for a guest. The page
 * pipeline's loader catch turns it into the ordinary redirect short-circuit,
 * so no lower loader starts and the handler answers with a 302 (document) or a
 * followed redirect (data navigation).
 */
export class PageRedirectSignal extends Error {
  public constructor(
    public readonly url: string,
    public readonly statusCode: number = 302,
  ) {
    super(`Page redirect to ${url}`);
    this.name = "PageRedirectSignal";
  }
}

export function isPageRedirectSignal(value: unknown): value is PageRedirectSignal {
  return value instanceof PageRedirectSignal;
}
