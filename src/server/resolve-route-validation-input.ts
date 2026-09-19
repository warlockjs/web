/**
 * Resolves the input for a page's top-level `validation` export's `params`
 * and `query` schemas (`web/src/validation.ts`) — the shape
 * `execute-page-request.ts` hands to `v.validate` when a page declares
 * `validation = { params, query }` rather than the legacy
 * `{ schema, validating }` form (whose input instead comes from
 * `resolve-validation-data.ts`).
 *
 * Deliberately the request's OWN `params`/`query`, kept as two separate keys,
 * never merged into one bag. Merging them would invent a collision between a
 * `:id` path segment and a `?id=` query key that nobody asked for and that a
 * schema author cannot see coming from reading their own schema.
 *
 * ONLY the sources the page declared are handed over (card 7d891485). The
 * combined schema is built from the declared keys alone, and a Seal object
 * rejects unknown keys by default — feeding an undeclared `params` to a
 * query-only page answered EVERY request with a 400 (`unknownKeys: params`).
 * The author's own inner schemas keep their strict default; only the outer
 * envelope, which the framework builds, is shaped to match.
 *
 * History: this mirrors what a now-withdrawn `route.validate` schema used to
 * be handed before the 5.9.0 validation collapse folded that into the
 * page-level `validation` export.
 */

export type PageValidationRequest = {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
};

/** Which of the two sources the page's `validation` export declared a schema for. */
export type PageValidationSources = {
  params: boolean;
  query: boolean;
};

export type PageValidationInput = {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
};

export function resolvePageValidationInput(
  request: PageValidationRequest,
  sources: PageValidationSources,
): PageValidationInput {
  return {
    ...(sources.params ? { params: request.params ?? {} } : {}),
    ...(sources.query ? { query: request.query ?? {} } : {}),
  };
}
