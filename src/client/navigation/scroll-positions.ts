/**
 * The saved scroll position of every history entry the client router has left.
 *
 * ## Why this exists at all
 *
 * `history.scrollRestoration` is being set to `"manual"` for client navigation
 * (`navigation-root.tsx`), which means the BROWSER stops restoring scroll on
 * Back/Forward — a client navigation replaces the document's content with
 * `history.replaceState`/`pushState` rather than loading a new document, and a
 * browser's own scroll restoration only fires around an actual navigation of
 * the latter kind reliably. So restoring the position on Back/Forward becomes
 * this module's job, and it needs somewhere to have kept it.
 *
 * ## Keyed by a per-entry key, never by URL
 *
 * Two different history entries can share a URL — a redirect loop, or the same
 * page visited twice in one session — and each has its own scroll position.
 * The key is a per-entry identifier `history-entry-key.ts` stamps onto
 * `history.state`, not the URL itself.
 *
 * ## Persisted, so a reload does not lose it
 *
 * The in-memory `Map` alone would forget everything on a reload — the exact
 * moment a real Back press is likely to follow. So every write is mirrored to
 * `sessionStorage`, hydrated back on boot, and EVERY access to storage is
 * wrapped in `try`/`catch`: a private-browsing tab can make the `sessionStorage`
 * property itself throw on read, not just the calls on it, and this feature
 * must degrade to "positions do not survive a reload" rather than to a crash.
 */

export type ScrollPosition = { readonly x: number; readonly y: number };

const STORAGE_KEY = "warlock:scroll-positions";

const positions = new Map<string, ScrollPosition>();

let hydrated = false;

function isScrollPosition(value: unknown): value is ScrollPosition {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).x === "number" &&
    typeof (value as Record<string, unknown>).y === "number"
  );
}

/**
 * `sessionStorage` itself, or `undefined` if reading the property, or the
 * property not existing at all (no `window`), failed. NEVER reached for
 * directly outside this function — see this file's header.
 */
function readSessionStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

function toRecord(): Record<string, ScrollPosition> {
  const record: Record<string, ScrollPosition> = {};

  for (const [key, value] of positions) record[key] = value;

  return record;
}

function persist(): void {
  try {
    const storage = readSessionStorage();

    storage?.setItem(STORAGE_KEY, JSON.stringify(toRecord()));
  } catch {
    // Storage full, disabled, or throwing — the in-memory Map is still
    // correct for the rest of this document's life, which is all a failing
    // persist can cost.
  }
}

/**
 * Load whatever a previous document in this tab saved, once. Idempotent and
 * safe to call from every boot path — a second call is a no-op even after a
 * hard failure on the first, since there is nothing more to learn from
 * retrying a `sessionStorage` that just threw.
 */
export function hydrateScrollPositions(): void {
  if (hydrated) return;

  hydrated = true;

  try {
    const storage = readSessionStorage();
    const raw = storage?.getItem(STORAGE_KEY);

    if (raw === null || raw === undefined) return;

    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== "object" || parsed === null) return;

    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isScrollPosition(value)) positions.set(key, value);
    }
  } catch {
    // A throwing getter, a blocked store, or corrupt JSON — start empty.
  }
}

/** Save `position` for `key`, in memory and (best-effort) in `sessionStorage`. */
export function saveScrollPosition(key: string, position: ScrollPosition): void {
  positions.set(key, position);
  persist();
}

/** @returns the position last saved for `key`, or `undefined` if none was. */
export function getScrollPosition(key: string): ScrollPosition | undefined {
  return positions.get(key);
}

/**
 * Drop everything. For tests, and for any caller that knows every saved
 * position is now meaningless — the module-level `Map` would otherwise
 * outlive a suite and leak into the next one.
 */
export function resetScrollPositions(): void {
  positions.clear();
  hydrated = false;
}
