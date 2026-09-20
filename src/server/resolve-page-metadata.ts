/**
 * Stage 8 of the page pipeline — METADATA.
 *
 * Its own file because the behaviour that matters here is about ERRORS, and
 * reaching an error path through the full ten-stage pipeline means standing up
 * a real Request/Response pair to observe a `try`/`catch`. See
 * `resolve-page-metadata.spec.ts`.
 *
 * ## Why a page's `metadata` never runs after a failed loader
 *
 * It used to. `design/request-lifecycle.md` said "exactly one of data/error
 * set", and stage 8 duly called `metadata({ data: undefined, error })` when a
 * loader rejected — while `PageMetadata` declared `data` as always present.
 * **The type lied**, so the natural way to write a metadata function was also
 * the broken way:
 *
 * ```ts
 * export const metadata: PageMetadata<typeof loader> = ({ data }) => ({
 *   title: "Home",
 *   description: `${data.products.length} products in stock`,
 * });
 * ```
 *
 * All three function-form metadata exports in the reference app were written
 * exactly like that, and all three turned a loader's real error — a
 * `MissingDataSourceError`, say — into `TypeError: Cannot read properties of
 * undefined`, reported against a different file in a different subsystem. The
 * cost was never the crash; it was that every future debugging session on a
 * failed loader would start by investigating the wrong thing.
 *
 * The alternative was to widen `data` to `| undefined` and make every author
 * handle a path almost none of them care about — and without a discriminant,
 * TypeScript cannot narrow `data` from `if (error)` anyway, so authors would
 * have reached for `data!` and re-created the lie with extra syntax.
 *
 * So: a page describes a page it actually has. When there is no data there is
 * no page-authored description, and the framework supplies
 * {@link ERROR_PAGE_METADATA} instead.
 *
 * ## Partial failure
 *
 * Stage 7 runs app, layout and page loaders root-to-leaf, so an ancestor
 * rejection prevents the page loader from starting. `failed` is still the
 * relevant guard here: any recorded error means a boundary renders instead of
 * the page, and metadata describes what is on screen. Describing a page the
 * visitor never received is the same defect in a quieter form.
 *
 * If per-page error metadata is ever wanted, it is a separate `errorMetadata`
 * export — a distinct signature for a distinct situation, not an arm of this
 * one. Nothing has asked for it.
 */

import type { SharedContext } from "../index";
import type { MetadataOutput, PageMetadata } from "../metadata";
import type { PipelineLoader } from "./execute-page-request";
import { guardMetadataAgainstDeferredKeys } from "./metadata-deferred-guard";

/**
 * What `<head>` gets when the page did not render.
 *
 * `robots` is the load-bearing member, not `title`. An error render is a
 * transient server state that happens to be reachable at a real URL; letting a
 * crawler index it puts "Something went wrong" in a search result for a page
 * that works. `title` is a fallback a boundary is free to improve on.
 */
export const ERROR_PAGE_METADATA: MetadataOutput = Object.freeze({
  title: "Something went wrong",
  robots: "noindex",
});

export type ResolvePageMetadataInput = {
  /** The page module's `metadata` export — absent, object, or function. */
  metadata: PageMetadata<PipelineLoader> | undefined;
  /** The composed layout's static metadata.robots, when it has one. */
  layoutRobots?: string;
  /** `bundle.pageData`. Read only when `failed` is false. */
  data: unknown;
  /** The value an earlier stage already recorded. Diagnostics only. */
  error: unknown;
  /** Whether an earlier stage recorded an error at all. */
  failed: boolean;
  shared: Readonly<SharedContext>;
  /**
   * `bundle.deferredKeys` (Stage 2, contract rule 3) — the page loader's
   * top-level `defer()`-ed key names, undefined for a page that never called
   * `defer()`. Used only to build the guarded view `metadata()` reads `data`
   * through; never read on the `failed` path, where `data` itself is not
   * read either.
   */
  deferredKeys?: readonly string[];
  /**
   * The matched page's route path — named in
   * {@link DeferredKeyInMetadataError} when `metadata()` reads a deferred key.
   */
  pagePath: string;
};

export type ResolvedPageMetadata = {
  metadata: MetadataOutput | undefined;
  /**
   * Set only when the page's own metadata function threw on the SUCCESS path.
   * Returned rather than rethrown so the caller can record it the same way a
   * loader throw is recorded — the boundary renders and the framework keeps
   * ownership of the status, instead of an exception escaping stage 8.
   *
   * Never set on the error path: nothing runs there that could throw, and an
   * error arriving at stage 8 has already won.
   */
  thrown?: unknown;
};

/** The function arm of `PageMetadata`, for the one call this module makes. */
type PageMetadataFunction = Extract<PageMetadata<PipelineLoader>, (...args: never) => unknown>;

function withLayoutRobots(metadata: MetadataOutput | undefined, layoutRobots: string | undefined) {
  if (layoutRobots === undefined || metadata?.robots !== undefined) return metadata;

  return { ...metadata, robots: layoutRobots };
}

export function resolvePageMetadata(input: ResolvePageMetadataInput): ResolvedPageMetadata {
  if (input.failed) {
    return { metadata: ERROR_PAGE_METADATA };
  }

  const { metadata } = input;

  if (typeof metadata !== "function") {
    return { metadata: withLayoutRobots(metadata, input.layoutRobots) };
  }

  try {
    const guardedData = guardMetadataAgainstDeferredKeys(
      input.data,
      input.deferredKeys,
      input.pagePath,
    );

    return {
      metadata: withLayoutRobots(
        (metadata as PageMetadataFunction)({
          data: guardedData as Parameters<PageMetadataFunction>[0]["data"],
          shared: input.shared,
        }),
        input.layoutRobots,
      ),
    };
  } catch (thrown) {
    return { metadata: ERROR_PAGE_METADATA, thrown };
  }
}
