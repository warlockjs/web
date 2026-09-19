/**
 * A tiny LRU-capped `string`-keyed store.
 *
 * Extracted out of `scroll-positions.ts` so the eviction policy — cap at
 * `capacity` entries, evict the least-recently-touched one, and treat both
 * a write (`set`) and a read (`get`) as a "touch" that makes an entry
 * most-recently-used — has exactly one place to be right, and one place to
 * unit-test directly if that ever becomes worth doing on its own.
 *
 * Backed by a `Map`, whose keys iterate in insertion order — re-inserting a
 * touched key (`delete` then `set`) moves it to the newest end, so the key
 * that comes first out of the iterator is always the least-recently-used
 * one.
 */

export const DEFAULT_LRU_CAPACITY = 50;

export interface LruCap<V> {
  /** Write `value` for `key`, touching it, then evict the LRU entry/entries until back at capacity. */
  set(key: string, value: V): void;
  /** Read the value for `key`, touching it on a hit. `undefined` on a miss — never inserted. */
  get(key: string): V | undefined;
  /** Current number of entries, always `<= capacity`. */
  readonly size: number;
  /** Entries oldest (least-recently-used) first. */
  entries(): IterableIterator<[string, V]>;
  /** Drop every entry. */
  clear(): void;
}

/** A store capped at `capacity` entries (default {@link DEFAULT_LRU_CAPACITY}), evicting least-recently-used. */
export function createLruCap<V>(capacity: number = DEFAULT_LRU_CAPACITY): LruCap<V> {
  const store = new Map<string, V>();

  function touch(key: string, value: V): void {
    store.delete(key);
    store.set(key, value);
  }

  return {
    set(key, value) {
      touch(key, value);

      while (store.size > capacity) {
        const oldestKey = store.keys().next().value as string;

        store.delete(oldestKey);
      }
    },
    get(key) {
      if (!store.has(key)) return undefined;

      const value = store.get(key) as V;

      touch(key, value);

      return value;
    },
    get size() {
      return store.size;
    },
    entries() {
      return store.entries();
    },
    clear() {
      store.clear();
    },
  };
}
