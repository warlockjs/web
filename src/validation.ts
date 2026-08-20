import type { Infer } from "@warlock.js/seal";

/**
 * The page's `validation` export: a Seal schema plus what to validate it
 * against. `schema` is kept structural (`unknown`) at the constraint so the
 * generic carries the CONCRETE validator type through — the inference happens
 * in `ValidatedOutput`, not here.
 */
export type PageValidation = {
  schema?: unknown;
  validating?: readonly string[];
};

/**
 * What `request.validated()` hands back: `Infer.Output`, not bare `Infer`.
 * Bare `Infer<T>` is `Infer.Input<T>` — the shape a CALLER sends, where
 * `.default()` makes a key optional. `validated()` describes the shape AFTER
 * defaults are injected, so `.default()` fields stay required
 * (v5/app/src/app/auth/schema/login.schema.ts:29-38,
 * seal/src/types/inference-types.ts:98-102).
 *
 * A page with no `validation` export (`PageLoader<undefined, …>`,
 * product-details.page.tsx:69) validates nothing: `validated()` answers the
 * empty object, which mirrors core's runtime (`request.ts:611-617`).
 */
export type ValidatedOutput<TValidation> = TValidation extends {
  schema: infer TSchema;
}
  ? Infer.Output<TSchema>
  : Record<string, never>;
