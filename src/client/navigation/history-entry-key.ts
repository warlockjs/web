/**
 * Give a history entry an identity that survives past its URL.
 *
 * A scroll position (`scroll-positions.ts`) belongs to an ENTRY, not a URL —
 * two entries can share a URL, and one entry's URL can change under it (a
 * client navigation's `apply()` puts the fragment back onto `finalUrl` with
 * `replaceState`, on the very entry that navigated). So every entry this
 * router touches is stamped with a small string key, carried on
 * `history.state`, which is the one piece of an entry that travels with it
 * across a reload and is handed back verbatim on Back/Forward.
 *
 * ## Existing state is preserved, never overwritten
 *
 * `history.state` is not this module's alone to own — a caller outside the
 * client router (or a future feature of this one) may already keep something
 * there. Every write here merges the key into whatever was already present
 * rather than replacing it, and a `replaceState` call never touches the URL.
 */

/** The property name the key is stored under inside `history.state`. */
const KEY_FIELD = "__warlockScrollKey";

let counter = 0;

/**
 * A key unique within this document's lifetime. Not a UUID: nothing here
 * needs global uniqueness, only "distinct from every other entry this tab
 * creates", and a counter proves that trivially and without a dependency.
 */
function generateEntryKey(): string {
  counter += 1;

  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @returns the key already stamped on `state`, or `undefined` if there is none. */
export function readEntryKey(state: unknown): string | undefined {
  if (!isRecord(state)) return undefined;

  const value = state[KEY_FIELD];

  return typeof value === "string" ? value : undefined;
}

/**
 * @returns `state` with `key` merged in under {@link KEY_FIELD}. Every other
 * field of `state` — if it was an object at all — is carried over untouched.
 */
export function withEntryKey(state: unknown, key: string): Record<string, unknown> {
  const base = isRecord(state) ? state : {};

  return { ...base, [KEY_FIELD]: key };
}

/** The one `History` surface this module needs — real, or a test double. */
export type EntryKeyHistory = {
  readonly state: unknown;
  replaceState(state: unknown, unused: string): void;
};

/**
 * Read the CURRENT entry's key, minting and writing one via `replaceState` if
 * it does not have one yet.
 *
 * Called whenever the router is about to need an entry's key and cannot
 * assume one was assigned when the entry was created — the entry the document
 * loaded on, most notably, which was never pushed by this router at all.
 *
 * `replaceState`'s URL argument is omitted, so the address bar is never
 * touched by this call.
 */
export function ensureEntryKey(history: EntryKeyHistory): string {
  const existing = readEntryKey(history.state);

  if (existing !== undefined) return existing;

  const key = generateEntryKey();

  history.replaceState(withEntryKey(history.state, key), "");

  return key;
}

/**
 * Mint a brand-new key for an entry the router is about to create — a `<Link>`
 * click or a `navigateTo()` call, which are always a NEW logical page even
 * when they replace the current entry. Exported separately from
 * {@link ensureEntryKey} because that distinction (new entry vs. the one
 * already on screen) is the caller's to make, not this module's to guess.
 */
export function createEntryKey(): string {
  return generateEntryKey();
}
