import type { ActionState } from "./server/action-state";
import type { ActionResponse } from "./server/settle-page-response";
import type { Request, Response } from "@warlock.js/core";
import type { BaseValidator, Infer } from "@warlock.js/seal";
import type { PageActionConfig } from "./page-config";
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
 * An action's `validation` is a bare Seal validator over the body, not the
 * page's `{ schema }` / `{ params, query }` shape, so it is inferred
 * directly. No validation validates nothing: the empty object.
 */
type ActionValidatedOutput<TConfig> = TConfig extends {
  readonly validation: infer TValidator extends BaseValidator;
}
  ? Infer.Output<TValidator>
  : Record<string, never>;

/**
 * What a page `action` receives: the page loader's context with the action's
 * own validated body and the buffered `ActionResponse` (failure helpers
 * included). `TConfig` is `typeof config.action` (or one `config.actions.<name>`).
 */
export type PageActionContext<TConfig extends PageActionConfig | undefined = undefined> = {
  request: Request<ActionValidatedOutput<TConfig>>;
  response: ActionResponse;
  shared: SharedContext;
  /** The resolved session; present only when `web.session` is configured. */
  session?: PageSession;
};

export type { ActionResponse, ActionState };
