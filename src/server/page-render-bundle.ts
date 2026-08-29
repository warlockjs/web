/**
 * The internal, non-serializable marker `renderPageFailure` (render-page.ts)
 * sets on its bundle AND on the document payload it hands to
 * `DocumentContext` — never on anything `finishRender` produces.
 *
 * `renderPageFailure` runs when a module-load or registration throw happens
 * BEFORE any page/layout/app triple exists — there is no trustworthy server
 * composition for the browser to hydrate against, unlike a normal app-owned
 * `error.page.tsx` reached through `finishRender`, which renders inside a
 * real triple and stays hydratable. Marking both the bundle (read by
 * `create-page-route-handler.ts`'s catch path to skip the hydration module)
 * and the payload (read by `<Scripts/>` to skip `__WARLOCK_DATA__`) lets both
 * call sites agree from the SAME flag instead of two independent guesses.
 *
 * A `Symbol`, non-enumerable, and never part of any exported type: nothing
 * that serializes or spreads these objects (`JSON.stringify`, `{ ...x }`) can
 * observe or carry it forward — only `isNonHydrating` reads it, and only
 * `markNonHydrating` writes it.
 */
const NON_HYDRATING = Symbol("warlock.web/non-hydrating");

type MarkedNonHydrating = {
  readonly [NON_HYDRATING]?: true;
};

/** Set only by `renderPageFailure` — see the module doc above. */
export function markNonHydrating<T extends object>(target: T): T {
  Object.defineProperty(target, NON_HYDRATING, {
    value: true,
    enumerable: false,
    configurable: true,
  });

  return target;
}

/** Read by `create-page-route-handler.ts` and `<Scripts/>` — see the module doc above. */
export function isNonHydrating(target: object | undefined): boolean {
  return target !== undefined && (target as MarkedNonHydrating)[NON_HYDRATING] === true;
}
