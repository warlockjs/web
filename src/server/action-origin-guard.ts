import {
  HttpErrorCodes,
  resolveCsrfOriginVerdict,
  type Request,
  type Response,
} from "@warlock.js/core";

/**
 * The always-on Origin/Referer check for a page action POST (5.21, design
 * §2.7). Core's default CSRF guard only fires when the request carries a
 * non-locale cookie, which leaves anonymous forms (login, sign-up, contact)
 * open to cross-site submission. An action is a state-changing POST, so it
 * requires a same-origin (or `auth.csrf.allowedOrigins`) `Origin`/`Referer`
 * whether or not any cookie is present. There is no opt-out.
 *
 * Returns `undefined` when the request may proceed, or the 403 `Response`
 * the caller must return straight away. The verdict is core's own
 * `resolveCsrfOriginVerdict`, so this cannot drift from the other two seams.
 */
export async function guardActionOrigin(
  request: Request,
  response: Response,
): Promise<Response | undefined> {
  if (resolveCsrfOriginVerdict(request).allowed) return undefined;

  return response.forbidden({
    error: "Cross-origin form submission refused.",
    errorCode: HttpErrorCodes.CsrfOriginMismatch,
  });
}
