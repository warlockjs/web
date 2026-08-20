/**
 * The `route` export's accepted shapes: the configured object
 * (`{ path, name } as const` — the `as const` is what keeps `path` a literal
 * a conditional type can parse, product-details.page.tsx:6-14) or the bare
 * path string for the 2-line minimum page (contact-us.page.tsx:27, where the
 * name is derived).
 */
export type RouteDeclaration =
  | string
  | {
      readonly path: string;
      readonly name?: string;
    };

type RoutePath<TRoute> = TRoute extends string
  ? TRoute
  : TRoute extends { readonly path: infer TPath extends string }
    ? TPath
    : never;

/**
 * Parameter names out of a path literal: `"/:id"` → `"id"`,
 * `"/a/:x/:y"` → `"x" | "y"`, `"/"` and `"*"` → `never` (so `request.input()`
 * is uncallable where no parameter exists to read).
 */
type PathParams<TPath extends string> = TPath extends `${string}:${infer TRest}`
  ? TRest extends `${infer TParam}/${infer TTail}`
    ? TParam | PathParams<`/${TTail}`>
    : TRest
  : never;

/**
 * `undefined` (no route generic supplied) keeps `input()` loose rather than
 * uncallable — the contract only narrows when the loader links its route via
 * `satisfies PageLoader<…, typeof route>`.
 */
export type RouteParamsOf<TRoute> = [TRoute] extends [undefined]
  ? string
  : PathParams<RoutePath<TRoute>>;
