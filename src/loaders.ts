import type { ActionState } from "./server/action-state";
import type { ActionResponse } from "./server/settle-page-response";
import type { Request, Response } from "@warlock.js/core";
import type { PageContext } from "./context";
import type { PageSession, SharedContext } from "./index";
import type { RouteDeclaration } from "./route";
import type { PageValidation, ValidatedOutput } from "./validation";

export type PageLoaderContext<
  TValidation extends PageValidation | undefined,
  TRoute extends RouteDeclaration | undefined,
> = {
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
  /** The resolved session; present only when `web.session` is configured. `user` is null for a guest. */
  session?: PageSession;
};

export type PageLoader<
  TValidation extends PageValidation | undefined = undefined,
  TRoute extends RouteDeclaration | undefined = undefined,
> = (context: PageLoaderContext<TValidation, TRoute>) => unknown;

export type LayoutLoaderContext = PageContext;

export type AppLoaderContext = PageContext;

export type LayoutLoader = (context: LayoutLoaderContext) => unknown;

export type AppLoader = (context: AppLoaderContext) => unknown;

/**
 * What a page `action` receives: the page loader's context with the action's
 * own validated body and the buffered `ActionResponse` (failure helpers
 * included). `TConfig` is `typeof config.action` (or one `config.actions.<name>`).
 */
export type PageActionContext<
  TConfig extends { validation?: PageValidation } | undefined = undefined,
> = {
  request: Request<
    ValidatedOutput<
      TConfig extends { validation: infer TValidation extends PageValidation }
        ? TValidation
        : undefined
    >
  >;
  response: ActionResponse;
  shared: SharedContext;
  /** The resolved session; present only when `web.session` is configured. */
  session?: PageSession;
};

export type { ActionResponse, ActionState };
