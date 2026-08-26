/**
 * The URL FRAGMENT, kept as a first-class part of a navigation.
 *
 * ## The defect this file exists for
 *
 * A client navigation asks the server for page data with `fetch`, and a
 * fragment is a CLIENT-SIDE construct: it is never sent, and `response.url` —
 * the URL history is written from, because it reflects any redirect that was
 * followed — therefore never carries one. So `<Link href="/docs#install">`
 * pushed `/docs` and the fragment the author wrote was silently gone from the
 * address bar: not shareable, not bookmarkable, not restorable on reload.
 *
 * Everything here is pure string work over `URL`, deliberately: the navigation
 * runtime is the only place that may touch `window`, and these answers have to
 * be provable in a suite with no browser.
 *
 * ## The redirect rule, which is the browser's rule
 *
 * When a request is redirected and the `Location` carries no fragment of its
 * own, the ORIGINAL fragment is carried onto the destination (RFC 7231 §7.1.2).
 * A `Location` that DOES name one wins outright. {@link withFragmentFrom} is
 * that rule and nothing else, so a client navigation through a redirect lands
 * where a full page load would have landed.
 */

/**
 * The fragment of `url`, WITHOUT its leading `#`.
 *
 * `undefined` means there was no `#` at all, and `""` means there was one with
 * nothing after it. The two are kept apart because they are different requests:
 * `/docs` says nothing about a fragment, `/docs#` says "no target" — and only
 * the second should end up written to the address bar as `#`.
 *
 * Plain string work rather than `new URL()`: this is asked of RELATIVE URLs
 * (`/docs#install`, `#install`), which `URL` cannot parse without a base, and
 * the base is `window`'s — not available on the server, and not this module's
 * to reach for.
 */
export function fragmentOf(url: string): string | undefined {
  const index = url.indexOf("#");

  return index === -1 ? undefined : url.slice(index + 1);
}

/**
 * `url` with everything from its `#` onward removed.
 */
export function withoutFragment(url: string): string {
  const index = url.indexOf("#");

  return index === -1 ? url : url.slice(0, index);
}

/**
 * Carry the fragment the caller ASKED for onto the URL the response came from.
 *
 * The resolved URL wins when it names a fragment itself — a redirect that says
 * `Location: /docs/v5#moved` meant it. Otherwise the requested fragment rides
 * along, which for the overwhelmingly common case (no redirect) simply puts
 * back what `fetch` dropped.
 */
export function withFragmentFrom(resolvedUrl: string, requestedUrl: string): string {
  if (fragmentOf(resolvedUrl) !== undefined) return resolvedUrl;

  const fragment = fragmentOf(requestedUrl);

  return fragment === undefined ? resolvedUrl : `${resolvedUrl}#${fragment}`;
}

/**
 * The `id` a fragment names, decoded.
 *
 * A fragment travels PERCENT-ENCODED — `#a%20b`, and every non-ASCII id is
 * encoded by the browser the moment it reaches the address bar — while the
 * `id` attribute in the document holds the decoded characters. Looking up the
 * raw fragment therefore misses every id with a space or a non-Latin letter,
 * which is a silent no-scroll indistinguishable from the bug this fixes.
 *
 * A malformed escape (`#100%`) is NOT an error here: `decodeURIComponent`
 * throws on it, and a throw during a navigation would cost the page for the
 * sake of a scroll. The raw text is returned instead, which is exactly what an
 * `id="100%"` in the document would match.
 */
export function fragmentTargetId(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

/**
 * The fragment of a destination that is THIS page with a fragment on it —
 * `#section`, or the current path written out in full with one appended.
 *
 * `undefined` means "not that": a different page, no fragment, or a URL that
 * cannot be resolved at all. The caller navigates as it otherwise would.
 *
 * Such a click must NOT run a client navigation. Re-fetching the page the user
 * is already looking at would throw away its DOM and every piece of state in
 * it — a scrolled container, an open menu, a playing video — to arrive at the
 * same page, and the round trip means the jump does not happen until the
 * network answers. The browser does not do that for a plain `<a href="#x">`
 * and neither do we: the URL is updated and the page scrolls, in that order.
 *
 * The comparison is on origin, path and QUERY: `?page=2#top` from `?page=1#top`
 * is a real navigation to different data that happens to share a fragment.
 *
 * An EMPTY fragment (`/here#`) does not qualify — there is no target to scroll
 * to and nothing to distinguish it from a plain re-navigation to the same page.
 */
export function samePageFragment(url: string, currentHref: string): string | undefined {
  let destination: URL;
  let current: URL;

  try {
    destination = new URL(url, currentHref);
    current = new URL(currentHref);
  } catch {
    return undefined;
  }

  const fragment = destination.hash.slice(1);

  if (fragment === "") return undefined;

  const samePage =
    destination.origin === current.origin &&
    destination.pathname === current.pathname &&
    destination.search === current.search;

  return samePage ? fragment : undefined;
}
