/**
 * Speculative page data, fetched on hover and spent on the click that follows.
 *
 * A prefetch is a GUESS. The user pointed at a link; they may never click it.
 * Everything about this module follows from that one fact:
 *
 *   - it never reports a failure — nobody asked for this request, so nobody may
 *     be told it failed. A failed prefetch leaves the cache empty and the click
 *     fetches for real, which is the behaviour we had before this file existed.
 *   - it never delays a click. `prefetchPageData` is fire-and-forget; the
 *     navigation path reads the cache synchronously and does not wait on it.
 *   - it is BOUNDED and it EXPIRES. A cached payload is a copy of a page that
 *     may already have changed, so it may only be served while it is very
 *     probably still true.
 *
 * ## The read side is deliberately separate from the write side
 *
 * `<Link>` writes (on hover); the navigation runtime reads (on click). Neither
 * knows about the other — they share a URL, and this module is the only thing
 * between them. That is what lets prefetch be added without touching the
 * navigation state machine.
 */
import type { PageDataResult } from "./fetch-page-data";
import { fetchPageData } from "./fetch-page-data";

/** A prefetch result worth keeping — only ever a successful payload. */
export type PrefetchedPageData = Extract<PageDataResult, { type: "payload" }>;

/**
 * How many pages may be held at once.
 *
 * Ten, because the working set this serves is "links the pointer has crossed in
 * the last few seconds", which is small by construction — a nav bar, a card
 * grid the user is scanning. A page payload is loader data, not markup, but it
 * is still measured in tens of kilobytes, so an unbounded map on a long-lived
 * SPA session is a slow leak with no upper edge. Ten covers scanning a menu and
 * costs at most a few hundred kilobytes in the worst case.
 *
 * Eviction is by INSERTION ORDER, not by recency: an entry here is written once
 * and read at most once, so there is no recency to track — the oldest guess is
 * always the one least likely to be spent.
 */
export const PREFETCH_CACHE_LIMIT = 10;

/**
 * How long a cached payload may be served, in milliseconds.
 *
 * Thirty seconds. This is a SAFETY bound and not a performance knob: the
 * interval this feature exists to cover is hover-to-click, which is well under
 * a second, and every millisecond beyond that is pure staleness risk. A payload
 * served after the user has changed the data behind it renders a wrong page —
 * silently, and with no way for them to tell. Thirty seconds is long enough
 * that a hesitant click still hits, and short enough that no realistic
 * "navigate away, mutate something, come back" flow can complete inside it.
 */
export const PREFETCH_TTL_MS = 30_000;

type CacheEntry = {
  result: PrefetchedPageData;
  /** `Date.now()` at which this entry stops being servable. */
  expiresAt: number;
};

/**
 * Insertion-ordered by `Map` contract, which is what makes eviction a `keys()
 * .next()` and not a bookkeeping structure.
 */
const cache = new Map<string, CacheEntry>();

/**
 * URLs with a request already in the air. Repeated `mouseenter` events on the
 * same anchor are the norm, not the exception — a pointer crossing a link fires
 * as the user's hand settles — and without this each one would be its own
 * request for the same page.
 */
const inFlight = new Set<string>();

/**
 * Whether there is a browser to prefetch from.
 *
 * Called rather than assumed because `<Link>` is universal: the same module
 * graph is evaluated during a server render, where a speculative request would
 * be a request the server makes to itself for a page nobody is looking at.
 */
function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function evictOldest(): void {
  const oldest = cache.keys().next();

  if (oldest.done !== true) cache.delete(oldest.value);
}

/**
 * Fetch a URL's page data ahead of the click, and cache it.
 *
 * NEVER REJECTS and never reports. The returned promise exists so a test can
 * await the speculative work; callers in the component tree discard it
 * (`void prefetchPageData(url)`) and must not await it — a click that waited on
 * a guess would be slower than one that never made it.
 *
 * The caller decides WHETHER a URL may be prefetched. This function does not
 * re-derive that: it has a URL and no way to tell an in-app path from a
 * cross-origin one it must never touch. `<Link>` gates on `isInApp`.
 */
export async function prefetchPageData(url: string): Promise<void> {
  if (!isBrowser()) return;

  if (inFlight.has(url)) return;

  // A fresh entry means the answer is already here; an expired one is dropped
  // now so the fetch below can replace it.
  const cached = cache.get(url);

  if (cached !== undefined) {
    if (cached.expiresAt > Date.now()) return;

    cache.delete(url);
  }

  inFlight.add(url);

  try {
    const result = await fetchPageData(url);

    /*
      `hard-navigate` is NOT cached. It is the signal that this URL needs a full
      page load — a 404, a redirect to an interstitial, a proxy that stripped
      the marker header. Caching it would mean the click either replays a
      failure or, worse, consults an entry that cannot be rendered. The click
      re-asks and gets the same answer, correctly, through the navigation path
      that already knows how to degrade.
    */
    if (result.type !== "payload") return;

    if (cache.size >= PREFETCH_CACHE_LIMIT) evictOldest();

    cache.set(url, { result, expiresAt: Date.now() + PREFETCH_TTL_MS });
  } catch {
    /*
      `fetchPageData` already converts every network failure into a
      `hard-navigate`, so reaching here means something unforeseen. It is
      swallowed anyway, deliberately and without a log: this request was
      speculative, the user never asked for it, and a console full of warnings
      about requests nobody made is how a helpful optimisation becomes noise
      that hides real errors.
    */
  } finally {
    // In `finally` so a failed attempt does not poison the URL for the rest of
    // the session — the next hover is allowed to try again.
    inFlight.delete(url);
  }
}

/**
 * Take the prefetched payload for a URL, if there is a live one.
 *
 * CONSUMING: the entry is removed whether or not the caller ends up using it.
 * One hover buys one saved round trip. Serving the same payload to a second
 * navigation would double the window in which it can be wrong, in exchange for
 * a saving the user did not notice the first time.
 *
 * @returns the cached result, or `undefined` — in which case the caller fetches
 * exactly as it did before this module existed.
 */
export function takePrefetchedPageData(url: string): PrefetchedPageData | undefined {
  const entry = cache.get(url);

  if (entry === undefined) return undefined;

  cache.delete(url);

  // Expiry is checked on READ, not on a timer: a timer would keep a
  // long-lived page waking up to clean a cache that is already bounded, and an
  // entry nobody reads costs nothing but the slot it is evicted from anyway.
  return entry.expiresAt > Date.now() ? entry.result : undefined;
}

/**
 * Drop everything. For tests, and for any caller that knows the cached pages
 * are now wrong — the module-level cache would otherwise outlive a suite and
 * leak into the next one.
 */
export function resetPrefetchCache(): void {
  cache.clear();
  inFlight.clear();
}
