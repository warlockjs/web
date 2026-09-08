import type { HttpContext } from "@warlock.js/core";
import type { Infer } from "@warlock.js/seal";

/**
 * One guard the PAGE itself declares on `route.middleware` — the same shape a
 * layout's own `middleware` export already runs (`../routing/layout-policy.ts`).
 * Ordering is fixed pipeline-wide, not per declaration: every layout on the
 * chain runs outermost-first, and the page's OWN middleware — whichever level
 * declared it — always runs LAST, closest to the loader
 * (`server/execute-page-request.ts`'s `LEVEL_ORDER`). A layout's auth gate can
 * therefore never be bypassed by a page's own guard.
 */
export type RouteMiddleware = (ctx: HttpContext) => unknown | Promise<unknown>;

/**
 * The `route` export's accepted shapes: the configured object
 * (`{ path, name } as const` — the `as const` is what keeps `path` a literal
 * a conditional type can parse, product-details.page.tsx:6-14) or the bare
 * path string for the 2-line minimum page (contact-us.page.tsx:27, where the
 * name is derived).
 *
 * `validate` and `middleware` are what let a page declare what it ACCEPTS,
 * on the route itself rather than in a layout one level up — canon `f2e514c0`:
 * anything a page varies on is declared by the page. `validate` is a Seal
 * schema run over `{ params, query }` — kept as two SEPARATE keys, never
 * merged into one bag, so a `:id` path segment and a `?id=` query key can
 * never collide or silently shadow one another (canon `b79c4f55`).
 */
export type RouteDeclaration =
  | string
  | {
      readonly path: string;
      readonly name?: string;
      /** A Seal object schema validated against `{ params, query }`. */
      readonly validate?: unknown;
      /** This page's own guards, run LAST in the pipeline's middleware chain. */
      readonly middleware?: readonly RouteMiddleware[];
    };

/**
 * What `request.validated()` types as when a `route.validate` schema is
 * declared: `{ params, query }`, each `Infer.Output` of the matching half of
 * the schema — never a flattened merge of the two (canon `b79c4f55`, point 1).
 * `undefined` (no `validate` declared) types as an empty object, mirroring
 * `../validation.ts`'s `ValidatedOutput` for the pre-existing top-level
 * `validation` export.
 */
export type RouteValidatedOutput<TRoute> = TRoute extends { readonly validate: infer TSchema }
  ? Infer.Output<TSchema>
  : Record<string, never>;

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
