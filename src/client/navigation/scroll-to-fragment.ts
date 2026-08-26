import { fragmentTargetId } from "../../routing/url-fragment";

/**
 * Put the element a fragment names on screen — the browser's job, done by hand
 * because a client navigation never let the browser see the fragment.
 *
 * ## A fragment that matches nothing is NOT an error
 *
 * It does not throw, and — decided with it — it does not cause the fragment to
 * be dropped from the URL either. A browser loading `/docs#gone` shows
 * `#gone` in the address bar and leaves the page where it is; an id that has
 * not been added yet, or a page whose content moved, is an ordinary state of
 * the web and not something to report. So the return value says whether
 * anything was found, for a caller that wants to know, and every caller today
 * is free to ignore it.
 *
 * ## Why the document is an argument
 *
 * The suite runs with no DOM (`web/vitest.config.ts` — `environment: "node"`),
 * so a module that reached for the global `document` could only be proved in a
 * browser. The structural type below is satisfied by a real `Document` and by
 * three lines of test double, which is what makes the lookup rules provable at
 * all.
 */

/** The two lookups, and nothing else this module needs from a `Document`. */
export type FragmentScrollDocument = {
  getElementById(id: string): { scrollIntoView(): void } | null;
  /**
   * The legacy anchor form, `<a name="install">`, which browsers still honour
   * as a fragment target and older documentation pages are still full of.
   * Optional so a test double may leave it out.
   */
  getElementsByName?(name: string): ArrayLike<{ scrollIntoView(): void }>;
};

/**
 * @param fragment the fragment WITHOUT its leading `#`, as
 * `fragmentOf`/`samePageFragment` return it. Still percent-encoded — decoding
 * is this function's job, via `fragmentTargetId`.
 *
 * @returns whether a target was found and scrolled to.
 */
export function scrollToFragment(
  documentNode: FragmentScrollDocument,
  fragment: string,
): boolean {
  // `/docs#` names no target. Nothing to look up, and nothing to move.
  if (fragment === "") return false;

  const id = fragmentTargetId(fragment);

  /*
    `getElementById`, never `querySelector("#" + id)`. An id is allowed to
    contain characters that are not valid in a CSS selector — `#1`, `#a.b`,
    `#a b` — and `querySelector` THROWS on those rather than missing them, which
    would turn a link to a legal id into an exception in the middle of a
    navigation.
  */
  const target = documentNode.getElementById(id) ?? namedAnchor(documentNode, id);

  if (target === undefined || target === null) return false;

  target.scrollIntoView();

  return true;
}

function namedAnchor(
  documentNode: FragmentScrollDocument,
  name: string,
): { scrollIntoView(): void } | undefined {
  const matches = documentNode.getElementsByName?.(name);

  return matches === undefined || matches.length === 0 ? undefined : matches[0];
}
