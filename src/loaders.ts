import type { Request, Response } from "@warlock.js/core";
import type { PageContext } from "./context";
import type { SharedContext } from "./index";
import type { RouteDeclaration } from "./route";
import type { PageValidation, ValidatedOutput } from "./validation";

type PageLoaderContext<
  TValidation extends PageValidation | undefined,
  _TRoute extends RouteDeclaration | undefined,
> = {
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
