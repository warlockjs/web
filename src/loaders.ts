import type { PageContext, WebRequest, WebResponse } from "./context";
import type { SharedContext } from "./index";
import type { RouteDeclaration, RouteParamsOf } from "./route";
import type { PageValidation, ValidatedOutput } from "./validation";

/**
 * The context a PAGE loader receives, narrowed by the page's own sibling
 * exports: `TValidation` types `request.validated()` off the schema,
 * `TRoute` types `request.input()` off the path literal. A sibling export
 * cannot contextually type an already-authored function — the generics are
 * the mechanism that links them (product-details.page.tsx:20-41).
 */
type PageLoaderContext<
  TValidation extends PageValidation | undefined,
  TRoute extends RouteDeclaration | undefined,
> = {
  request: WebRequest<ValidatedOutput<TValidation>, RouteParamsOf<TRoute>>;
  response: WebResponse;
  shared: SharedContext;
};

/**
 * The page controller's contract. Used with `satisfies`, NEVER `:` — an
 * annotation replaces the inferred type and `PageProps<typeof loader>` loses
 * `data` (v5/app README §A). The return is `unknown` because `satisfies`
 * preserves whatever the loader actually returns; the short-circuit brand and
 * the props types do the narrowing on the way out.
 *
 * `TValidation` may be `undefined` — a page with no `validation` export
 * (product-details.page.tsx:69). `TRoute` may be the config object or a bare
 * string literal (contact-us.page.tsx:27).
 */
export type PageLoader<
  TValidation extends PageValidation | undefined = undefined,
  TRoute extends RouteDeclaration | undefined = undefined,
> = (context: PageLoaderContext<TValidation, TRoute>) => unknown;

/**
 * A layout's controller. Bare — no generics — in every v5/app use
 * (products/web/layout.tsx:53-58, dashboard.layout.tsx:34-36): a layout has
 * no `validation`/`route` exports to link, and the contract is the annotated
 * type, not a parameter list (`async () => …` is still a controller with the
 * full context available).
 */
export type LayoutLoader = (context: PageContext) => unknown;

/**
 * The application root's controller (root.tsx:56-58). Same shape as
 * `LayoutLoader`; a separate name because the two revalidate and nest under
 * different rules, and conflating them would make that drift invisible.
 */
export type AppLoader = (context: PageContext) => unknown;
