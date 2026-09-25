import { config, ForbiddenError, UnAuthorizedError, type Middleware } from "@warlock.js/core";
import { isPrefixedLocale, readLocaleRouting } from "../routing/locale-routing";
import { withLocalePrefix } from "../routing/locale-prefixed-paths";
import type { PipelineLoaderContext } from "../server/execute-page-request.types";
import { PageRedirectSignal } from "./page-redirect-signal";
import { safeRedirectTarget } from "./safe-redirect-target";
import type { SessionModel, SessionResolver } from "./session.types";

/** What the loader form reads: satisfied by the pipeline context and every public loader context. */
export type RequireUserContext = Pick<PipelineLoaderContext, "request" | "session">;

export type RequireUserOptions = {
  /** Login destination. @default auth.pageAuth.loginPath */
  loginPath?: string;
  /** Only this user type passes; anyone else gets a 403. */
  userType?: string;
  /** Extra check on the model; `false` gives a 403. */
  when?: (model: SessionModel) => boolean | Promise<boolean>;
};

export type RequireGuestOptions = {
  /** Where a signed-in user goes when no safe `redirect` query is present. @default "/" */
  to?: string;
};

function readResolver(): SessionResolver | undefined {
  return config.key<SessionResolver | undefined>("web.session", undefined);
}

function returnParamName(): string {
  return config.key<string>("auth.pageAuth.returnUrlParam", "redirect");
}

/** Prefixes `path` with the request locale when locale-URL routing prefixes it. */
function localizeLoginPath(path: string, locale: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;

  const routing = readLocaleRouting();

  if (routing.codes.some((code) => path === `/${code}` || path.startsWith(`/${code}/`))) {
    return path;
  }

  return isPrefixedLocale(routing, locale) ? withLocalePrefix(path, locale) : path;
}

function isLoaderContext(value: unknown): value is RequireUserContext {
  return typeof value === "object" && value !== null && "request" in value;
}

/** Loader form: reads the session stage 2.5 resolved; a guest throws a `PageRedirectSignal`. */
function requireUserInLoader(ctx: RequireUserContext, options: RequireUserOptions): SessionModel {
  const { request } = ctx;
  const session = ctx.session;

  if (!session?.user) {
    const loginPath = options.loginPath ?? config.key<string | undefined>("auth.pageAuth.loginPath");

    if (!loginPath || request.authorizationValue) throw new UnAuthorizedError("Unauthorized");

    const destination = localizeLoginPath(loginPath, request.locale);
    const separator = destination.includes("?") ? "&" : "?";

    throw new PageRedirectSignal(
      `${destination}${separator}${returnParamName()}=${encodeURIComponent(request.url)}`,
    );
  }

  const model = session.model as SessionModel;

  if (options.userType && (model as { userType?: string } | null)?.userType !== options.userType) {
    throw new ForbiddenError("Forbidden");
  }

  if (options.when) {
    const allowed = options.when(model);

    if (allowed instanceof Promise) {
      throw new Error("requireUser(ctx, { when }) needs a synchronous `when`; use the middleware form for async checks.");
    }

    if (!allowed) throw new ForbiddenError("Forbidden");
  }

  return model;
}

/**
 * Loader form: `const model = requireUser(ctx, options?)`. A guest throws a
 * `PageRedirectSignal` (a 302 to the login page) and lower loaders never run.
 */
export function requireUser(ctx: RequireUserContext, options?: RequireUserOptions): SessionModel;
export function requireUser(options?: RequireUserOptions): Middleware;
/**
 * Page middleware: guests are redirected to the login page (302, followed by
 * data navigations too); bearer clients and apps without a `loginPath` get a
 * 401; a failed `userType`/`when` check gets a 403.
 */
export function requireUser(
  first?: RequireUserContext | RequireUserOptions,
  second?: RequireUserOptions,
): Middleware | SessionModel {
  if (isLoaderContext(first)) return requireUserInLoader(first, second ?? {});

  const options: RequireUserOptions = first ?? {};

  const middleware: Middleware = async ({ request, response }) => {
    const resolved = await readResolver()?.resolve(request, response);

    if (!resolved) {
      const loginPath = options.loginPath ?? config.key<string | undefined>("auth.pageAuth.loginPath");

      if (!loginPath || request.authorizationValue) {
        return response.unauthorized({ error: "Unauthorized" });
      }

      const destination = localizeLoginPath(loginPath, request.locale);
      const separator = destination.includes("?") ? "&" : "?";

      return response.redirect(
        `${destination}${separator}${returnParamName()}=${encodeURIComponent(request.url)}`,
      );
    }

    const model = resolved.model as SessionModel;

    if (options.userType && (model as { userType?: string } | null)?.userType !== options.userType) {
      return response.forbidden({ error: "Forbidden" });
    }

    if (options.when && !(await options.when(model))) {
      return response.forbidden({ error: "Forbidden" });
    }
  };

  return middleware;
}

/** Page middleware: a signed-in user is sent away from guest-only pages such as login. */
export function requireGuest(options: RequireGuestOptions = {}): Middleware {
  return async ({ request, response }) => {
    const resolved = await readResolver()?.resolve(request, response);

    if (!resolved) return;

    const target = safeRedirectTarget(request.input(returnParamName())) ?? options.to ?? "/";

    return response.redirect(target);
  };
}
