import type { ActionState } from "./server/action-state";
import type { ActionResponse } from "./server/settle-page-response";
import type { Request, RequestLocals, Response } from "@warlock.js/core";
import type { BaseValidator, Infer } from "@warlock.js/seal";
import type { PageActionConfig } from "./page-config";
import type { PageContext, PageRoute, PageSite } from "./context";
import type { PageSession, SharedContext } from "./index";
import type { RouteDeclaration } from "./route";
import type { GuardedPageRouteName } from "./routing/route-types";
import type { SessionModel, SessionUser } from "./session/session.types";
import type { PageValidation, ValidatedOutput } from "./validation";

/** The declared route name of a `route` type (`typeof config.route`), or `undefined` when it has none. */
type DeclaredRouteName<TRoute> = TRoute extends { readonly name: infer Name extends string }
  ? Name
  : undefined;

/** Whether `TName` is (every member of) the statically guarded page names. */
type IsGuardedName<TName> = [TName] extends [never]
  ? false
  : [TName] extends [GuardedPageRouteName]
    ? true
    : false;

/**
 * What `request.locals.user` holds on a guarded page. The registered `SessionModel` when the
 * app declares one; otherwise whatever the app's own `RequestLocals["user"]` augmentation
 * (auth's `RequestUser`) says, read off core's interface so web still never imports auth.
 */
type GuardedLocalsUser = NonNullable<
  unknown extends SessionModel
    ? RequestLocals extends { user?: infer LocalUser }
      ? LocalUser
      : unknown
    : SessionModel
>;

/** The session a guarded page is guaranteed to have: signed in, so neither field is null. */
export type GuardedPageSession = {
  user: NonNullable<SessionUser>;
  model: NonNullable<SessionModel>;
};

/**
 * A page loader's context. `TName` is the page's route name and defaults to the `name` in
 * `TRoute`; when it is a statically guarded page (see {@link GuardedPageRouteName}) the
 * signed-in user is part of the type: `request.locals.user` and `session` are non-null.
 */
export type PageLoaderContext<
  TValidation extends PageValidation | undefined = undefined,
  TRoute extends RouteDeclaration | undefined = undefined,
  TName extends string | undefined = DeclaredRouteName<TRoute>,
> = IsGuardedName<TName> extends true
  ? Omit<UnguardedPageLoaderContext<TValidation>, "request" | "session"> & {
      request: UnguardedPageLoaderContext<TValidation>["request"] & {
        locals: { user: GuardedLocalsUser };
      };
      session: GuardedPageSession;
    }
  : UnguardedPageLoaderContext<TValidation>;

type UnguardedPageLoaderContext<TValidation extends PageValidation | undefined> = {
  /**
   * `validated()` carries the page's ONE validation surface: the top-level
   * `validation` export. `route.validate` was withdrawn after 5.6.0 and is
   * refused at boot, so there is no second shape to merge in.
   *
   * The `RouteValidatedOutput<TRoute>` intersection that used to sit here is
   * gone. It had already been emptied to `Record<string, never>`, which —
   * measured, not assumed — does NOT collapse the declared properties to
   * `never`; it was inert rather than harmful. Inert is still worth removing:
   * a type that reads as a second validation surface is a type that gets
   * treated as one.
   */
  request: Request<ValidatedOutput<TValidation>>;
  response: Response;
  shared: SharedContext;
  site?: PageSite;
  /** The matched page's route (not core's `/*` catch-all under `sites`). */
  route: PageRoute;
  /** The resolved session; present only when `web.session` is configured. `user` is null for a guest. */
  session?: PageSession;
};

export type PageLoader<
  TValidation extends PageValidation | undefined = undefined,
  TRoute extends RouteDeclaration | undefined = undefined,
  TName extends string | undefined = DeclaredRouteName<TRoute>,
> = (context: PageLoaderContext<TValidation, TRoute, TName>) => unknown;

/**
 * The layout loader receives the same resolved session as a page loader.
 * It is omitted when `web.session` is not configured, and has a null user
 * for a guest.
 */
export type LayoutLoaderContext = PageContext & { session?: PageSession };

/**
 * The app loader runs after session resolution, before layout and page
 * loaders, so it receives the same session shape as the other loaders.
 */
export type AppLoaderContext = PageContext & { session?: PageSession };

export type LayoutLoader = (context: LayoutLoaderContext) => unknown;

export type AppLoader = (context: AppLoaderContext) => unknown;

/**
 * An action's `validation` is a bare Seal validator over the body, not the
 * page's `{ schema }` / `{ params, query }` shape, so it is inferred
 * directly. No validation validates nothing: the empty object.
 */
type ActionValidatedOutput<TConfig> = TConfig extends {
  readonly validation: infer TValidator extends BaseValidator;
}
  ? Infer.Output<TValidator>
  : TConfig extends BaseValidator
    ? Infer.Output<TConfig>
    : Record<string, never>;

/**
 * What a page `action` receives: the page loader's context with the action's
 * own validated body and the buffered `ActionResponse` (failure helpers
 * included). `TConfig` is `typeof config.action` (or one `config.actions.<name>`).
 */
export type PageActionContext<TConfig extends PageActionConfig | BaseValidator | undefined = undefined> = {
  request: Request<ActionValidatedOutput<TConfig>>;
  response: ActionResponse;
  shared: SharedContext;
  site?: PageSite;
  /** The matched page's route (not core's `/*` catch-all under `sites`). */
  route: PageRoute;
  /** The resolved session; present only when `web.session` is configured. */
  session?: PageSession;
};

export type { ActionResponse, ActionState };
