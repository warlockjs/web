/**
 * Stage 4's input — what the page's `validation.schema` is handed.
 *
 * ## One request, one parse, one grammar
 *
 * This used to draw its four sources from **two** places. `body` and `headers`
 * came from the request; `query` and `params` came from a match object that
 * `execute-page-request.ts` built by re-parsing the URL itself with
 * `Object.fromEntries(new URLSearchParams(...))`.
 *
 * Core's parser is bracket-aware and preserves repeated keys. That one is
 * neither:
 *
 * ```
 * ?tags=a&tags=b&filter[status]=active
 *   core  → { tags: ["a","b"], filter: { status: "active" } }
 *   match → { tags: "b", "filter[status]": "active" }
 * ```
 *
 * **So a page's validation rules were checking different data than its loader
 * received.** A rule on `filter.status` could never fire — validation saw a key
 * literally named `filter[status]` — and where a key was sent twice, only the
 * last value was ever examined. A field the author believed was validated was
 * not, and nothing about that was visible from reading the validation rules.
 *
 * Every source is now the request. Core has already parsed the URL by the time
 * this runs; parsing it a second time can only ever produce a second answer.
 *
 * Mirrors core's `validateAll.ts:8-31`, with the page default: **params +
 * query, not body** — a page load is a GET.
 */

export type ValidationRequest = {
  body?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
};

/** The four names a page may list in `validation.validating`. */
const SOURCES = {
  body: (request: ValidationRequest) => request.body,
  query: (request: ValidationRequest) => request.query,
  params: (request: ValidationRequest) => request.params,
  headers: (request: ValidationRequest) => request.headers,
} as const;

export function resolveValidationData(
  validating: readonly string[] | undefined,
  request: ValidationRequest,
): Record<string, unknown> {
  // The page default. `params` last so a route parameter wins a query key of
  // the same name — the URL path is the more authoritative of the two.
  if (!validating || validating.length === 0) {
    return { ...request.query, ...request.params };
  }

  let data: Record<string, unknown> = {};

  for (const source of validating) {
    const read = SOURCES[source as keyof typeof SOURCES];

    // An unknown source name contributes nothing rather than throwing: the
    // list is app-authored, and stage 4 is not the place to litigate it.
    if (read) data = { ...data, ...(read(request) ?? {}) };
  }

  return data;
}
