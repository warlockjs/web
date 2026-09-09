import type { HttpContext } from "@warlock.js/core";

/**
 * A guard declared on the page's own top-level `middleware` export — the same
 * shape a layout's own `middleware` export already runs
 * (`../routing/layout-policy.ts`). Ordering is fixed pipeline-wide, not per
 * declaration: every layout on the chain runs outermost-first, and the page's
 * OWN `middleware` export always runs LAST, closest to the loader
 * (`server/execute-page-request.ts`'s `LEVEL_ORDER`). A layout's auth gate can
 * therefore never be bypassed by a page's own guard.
 *
 * `route.middleware` is NOT this surface — it shipped in 5.6.0 and was
 * withdrawn (owner ruling, 2026-09-08): a page declares middleware in exactly
 * one place, the top-level `middleware` export. A page still exporting
 * `route.middleware` fails loudly at request time rather than being silently
 * ignored — see `RouteMiddlewareRemovedError` in `./server/execute-page-request.ts`.
 */
export type RouteMiddleware = (ctx: HttpContext) => unknown | Promise<unknown>;

/**
 * The `route` export's accepted shapes: the configured object
 * (`{ path, name } as const` — the `as const` is what keeps `path` a literal
 * a conditional type can parse, product-details.page.tsx:6-14) or the bare
 * path string for the 2-line minimum page (contact-us.page.tsx:27, where the
 * name is derived).
 *
 * `route` is about the URL only. What a page ACCEPTS on that URL is declared
 * with `validate` here (a Seal schema run over `{ params, query }` — kept as
 * two SEPARATE keys, never merged into one bag, so a `:id` path segment and a
 * `?id=` query key can never collide or silently shadow one another, canon
 * `b79c4f55`). What a page REQUIRES to be reached at all is declared with the
 * page's own top-level `middleware` export, not here.
 */
export type RouteDeclaration =
  | string
  | {
      readonly path: string;
      readonly name?: string;
      /** A Seal object schema validated against `{ params, query }`. */
    };

/**
 * @deprecated Route validation is declared by the top-level `validation` export.
 * Retained as the empty half of the loader's legacy route generic until that
 * generic is removed; it never describes a second validation surface.
 */
export type RouteValidatedOutput<TRoute> = Record<string, never>;

/**
 * What `request.validated()` types as when a `route.validate` schema is
 * declared: `{ params, query }`, each `Infer.Output` of the matching half of
 * the schema — never a flattened merge of the two (canon `b79c4f55`, point 1).
 * `undefined` (no `validate` declared) types as an empty object, mirroring
 * `../validation.ts`'s `ValidatedOutput` for the pre-existing top-level
 * `validation` export.
 */
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
