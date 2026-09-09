/**
 * Stage 4b's input — what a page's `route.validate` schema is handed.
 *
 * Deliberately the request's OWN `params`/`query`, kept as two separate keys,
 * never merged into one bag: canon `b79c4f55`, point 1. Merging them would
 * invent a collision between a `:id` path segment and a `?id=` query key that
 * nobody asked for and that a schema author cannot see coming from reading
 * their own schema.
 */

export type PageValidationRequest = {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
};

export type PageValidationInput = {
  params: Record<string, unknown>;
  query: Record<string, unknown>;
};

export function resolvePageValidationInput(request: PageValidationRequest): PageValidationInput {
  return { params: request.params ?? {}, query: request.query ?? {} };
}
