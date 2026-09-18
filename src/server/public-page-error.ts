/**
 * The ONLY way an error's own `message` is allowed to reach the browser in
 * production. `serializePageError` (`./error-page.ts`) treats every other
 * thrown value as unsafe by default — never inferring safety from a status
 * code, an error name, or `NODE_ENV` alone — so a loader/middleware that
 * wants its message shown to a real visitor must throw (or wrap the cause
 * in) this class explicitly.
 */
export class PublicPageError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PublicPageError";
  }
}
