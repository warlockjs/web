import type { Request, Response } from "@warlock.js/core";
import type { PageContext } from "./context";
import type { SharedContext } from "./index";
import type { RouteDeclaration } from "./route";
import type { PageValidation, ValidatedOutput } from "./validation";

type PageLoaderContext<
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
};

export type PageLoader<
  TValidation extends PageValidation | undefined = undefined,
  TRoute extends RouteDeclaration | undefined = undefined,
> = (context: PageLoaderContext<TValidation, TRoute>) => unknown;

export type LayoutLoader = (context: PageContext) => unknown;

export type AppLoader = (context: PageContext) => unknown;
