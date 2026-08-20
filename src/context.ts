import type { SharedContext } from "./index";

/**
 * The brand behind loader short-circuits.
 *
 * Core's `Response#notFound()` / `#redirect()` return an unbranded
 * `Response`/`this` (core/src/http/response.ts:862-866, 1028-1034). The page
 * contract needs those returns to NOT union into `PageProps["data"]`
 * (v5/app/src/app/products/web/product-details.page.tsx:45-57), so web brands
 * them on ITS OWN response surface — the one a loader's context carries —
 * without touching core. `LoaderData` excludes exactly this brand.
 */
declare const loaderShortCircuit: unique symbol;

export interface LoaderShortCircuit {
  readonly [loaderShortCircuit]: true;
}

/**
 * The request as a loader sees it. Structural and deliberately minimal for M1:
 * exactly the members the v5/app loaders exercise, typed by the page's own
 * `validation` and `route` generics.
 *
 * TODO(Stream A.6 — core ctx migration): once core ships
 * `HttpContext { request, response }` and the declared `request.user` /
 * `request.locals` / `request.nonce` (design/core-asks-v5.md asks #2 and #8,
 * pending the ctx ruling), this narrows to a refinement of core's `Request`
 * instead of a standalone structural type.
 */
export interface WebRequest<
  TValidated = Record<string, never>,
  TParams extends string = string,
> {
  /**
   * The validated inputs, typed off the page's `validation.schema` with
   * `Infer.Output` semantics — `.default()` fields stay required
   * (v5/app/src/app/auth/schema/login.schema.ts:29-38). The key-list parameter
   * is optional and selects a subset, mirroring core
   * (core/src/http/request.ts:610).
   */
  validated(inputs?: readonly (keyof TValidated | (string & {}))[]): TValidated;

  /**
   * Typed FROM THE ROUTE: `TParams` is derived from the route path literal, so
   * `request.input("id")` types against `path: "/:id"` and a key that is not a
   * route parameter is a compile error
   * (v5/app/src/web/__type-tests__/route-params.type-test.ts).
   */
  input(key: TParams, defaultValue?: unknown): string;

  /**
   * The authenticated user, when middleware resolved one.
   *
   * `any`, deliberately, and recorded as a deviation in the M1 report: the
   * reference app hands `request.user` to services typed against the APP's own
   * model (`navService.forUser(user: User)`,
   * v5/app/src/web/layouts/dashboard.layout.tsx:35) and reads `.id` with no
   * null-check (settings.page.tsx:65). No type this package can declare is
   * assignable to an app-owned model class; the real declaration is core ask
   * #2 (design/core-asks-v5.md §2) and lands with Stream A.6.
   */
  user: any;
}

/**
 * The response as a loader sees it. A loader may mutate the response during
 * render (headers, status) and may SHORT-CIRCUIT it — the short-circuiting
 * methods return the branded type that never reaches `PageProps["data"]`.
 *
 * TODO(Stream A.6): same story as `WebRequest` — becomes a refinement of
 * core's `Response` once the ctx object lands in core.
 */
export interface WebResponse {
  /** Buffered, committed in tree order after every loader settles. */
  header(key: string, value: string): WebResponse;

  /** The not-found page's loader's real output is the status (not-found.page.tsx:25). */
  setStatusCode(statusCode: number): WebResponse;

  /** A short-circuit, not a value — never unions into `data`. */
  redirect(url: string, statusCode?: number): LoaderShortCircuit;

  /** 301 flavour of the same short-circuit. */
  permanentRedirect(url: string): LoaderShortCircuit;

  /** A 404 is an ANSWER, not an incident (product-details.page.tsx:45-57). */
  notFound(body?: unknown): LoaderShortCircuit;
}

/**
 * The one context object every handler receives.
 *
 * TODO(Stream A.6): core is to OWN `HttpContext { request, response }` and the
 * re-parameterised `Middleware<TContext extends HttpContext>`. Core today has
 * no `HttpContext` and its `Middleware` is positional `(request, response)`
 * (core/src/router/types.ts:17), so importing the type from
 * `@warlock.js/core` cannot resolve to the v5 shape yet — this structural
 * declaration stands in until the ctx ruling ships it there.
 */
export interface HttpContext {
  request: WebRequest;
  response: WebResponse;
}

/**
 * The web layer's context: `HttpContext` plus the per-request payload. The
 * keys are framework-owned and the list is closed — `request`, `response`,
 * `shared`. App data goes on `request.locals` (private) or `shared` (public),
 * never onto the context itself.
 */
export interface PageContext extends HttpContext {
  shared: SharedContext;
}
