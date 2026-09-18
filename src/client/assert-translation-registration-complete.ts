/**
 * The DEVELOPMENT-ONLY invariant for client navigation's translation gap.
 *
 * Initial hydration installs the payload's `translations` directly
 * (`hydrate-page.tsx`'s `extend(payload.locale, payload.translations)`), so by
 * the time a page renders, the browser's `@mongez/localization` table is
 * BUILT FROM the exact keywords the server says the page needs. A client
 * navigation has no such explicit install: the composed page/layout modules'
 * `register()` hooks (`register-modules.ts`) are relied on to have called
 * `extend()` themselves for the target locale. A hand-written or stale
 * generated `register()` that omits a locale branch leaves the table short —
 * `useTrans()` then returns the raw key, silently, because
 * `@mongez/localization` has no concept of a "missing" keyword, only an
 * absent one it falls through on.
 *
 * This compares what the SERVER says the page needed (`payload.translations`,
 * `hydration-payload.ts`'s required `translations` key) against what is
 * actually registered client-side for that locale right after `register()`
 * has run, and fails closed — the same floor `hydration-payload.ts` already
 * applies to an incomplete PAYLOAD, extended here to an incomplete
 * REGISTRATION.
 */
import { getKeywordsListOf, type Keywords } from "@mongez/localization";

function isKeywords(value: string | Keywords): value is Keywords {
  return typeof value === "object" && value !== null;
}

/**
 * Every dot-path in `required` that is absent, or present as the wrong shape
 * (a nested table where a string was required, or vice versa), in
 * `registered`.
 */
function findMissingTranslationPaths(
  required: Keywords,
  registered: Keywords,
  prefix: string,
): string[] {
  const missing: string[] = [];

  for (const key of Object.keys(required)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    const requiredValue = required[key] as string | Keywords;
    const registeredValue = registered[key];

    if (isKeywords(requiredValue)) {
      if (registeredValue === undefined || !isKeywords(registeredValue)) {
        missing.push(path);
        continue;
      }

      missing.push(...findMissingTranslationPaths(requiredValue, registeredValue, path));
    } else if (registeredValue === undefined) {
      missing.push(path);
    }
  }

  return missing;
}

/**
 * Thrown instead of letting the page render with keys `useTrans()` cannot
 * resolve. `navigation-root.tsx`'s `apply()` already treats a rejected
 * `buildTree()` as a reason to hard-navigate (its own stale-bundle recovery
 * path) — this reuses that exact floor rather than adding a second one.
 */
export class IncompleteTranslationRegistrationError extends Error {
  public constructor(
    public readonly pageName: string,
    public readonly locale: string,
    public readonly missingKeys: readonly string[],
  ) {
    const keyList = missingKeys.map((key) => JSON.stringify(key)).join(", ");

    super(
      `Warlock navigation aborted: page ${JSON.stringify(pageName)} needs the locale ` +
        `${JSON.stringify(locale)} translation ${missingKeys.length === 1 ? "key" : "keys"} ` +
        `${keyList}, but the client registry has ${missingKeys.length === 1 ? "it" : "them"} ` +
        "missing after this page's register() hooks ran. The generated projection is likely " +
        "stale or missing a locale branch — rebuild the client bundle, or check the page's/" +
        "layout's exported register().",
    );
    this.name = "IncompleteTranslationRegistrationError";
  }
}

/**
 * Called at the narrowest post-register, pre-render boundary
 * (`build-hydrated-tree.ts`, right after `registerModules()` and before any
 * component is created). Development-only: the walk below costs nothing a
 * production render needs to pay for a projection CI has already verified.
 */
export function assertTranslationRegistrationComplete(
  pageName: string,
  locale: string,
  requiredTranslations: Keywords,
): void {
  const registered = getKeywordsListOf(locale) ?? {};
  const missingKeys = findMissingTranslationPaths(requiredTranslations, registered, "");

  if (missingKeys.length > 0) {
    throw new IncompleteTranslationRegistrationError(pageName, locale, missingKeys);
  }
}
