import type { Request, Response } from "@warlock.js/core";
import type { PageContext } from "./context";
import type { SharedContext } from "./index";
import type { RouteDeclaration, RouteValidatedOutput } from "./route";
import type { PageValidation, ValidatedOutput } from "./validation";

type PageLoaderContext<
  TValidation extends PageValidation | undefined,
  TRoute extends RouteDeclaration | undefined,
> = {
  /**
   * `validated()` carries BOTH validation surfaces a page may declare: the
   * pre-existing top-level `validation` export's flat shape, and
   * `route.validate`'s `{ params, query }` — merged by intersection so a page
   * using either (or, at the type level, both) sees every field typed rather
   * than validating again inside the loader (canon `1ca1e8ae`).
   */
  request: Request<ValidatedOutput<TValidation> & RouteValidatedOutput<TRoute>>;
  response: Response;
  shared: SharedContext;
};

export type PageLoader<
  TValidation extends PageValidation | undefined = undefined,
  TRoute extends RouteDeclaration | undefined = undefined,
> = (context: PageLoaderContext<TValidation, TRoute>) => unknown;

export type LayoutLoader = (context: PageContext) => unknown;

export type AppLoader = (context: PageContext) => unknown;
