import type { Request } from "@warlock.js/core";

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDevalueNativeValue(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof RegExp ||
    value instanceof URL
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Converts page-loader data to the same JSON-facing shape as a core response
 * body, while retaining the richer values that devalue can represent itself.
 *
 * Synchronous unless some `toJSON()` returns a promise: deferred values are
 * settled against a timeout race, so an unconditional `await` here would add
 * microtask turns to every deferred key even when nothing needed converting.
 */
export function serializeLoaderData(value: unknown, request: Request): unknown {
  if (!value || typeof value !== "object") return value;

  // Buffer has a `toJSON`, and streams can carry arbitrary body data.
  if (
    Buffer.isBuffer(value) ||
    value instanceof Uint8Array ||
    typeof (value as { pipe?: unknown }).pipe === "function"
  ) {
    return value;
  }

  // Check these before `toJSON`: Date in particular implements it.
  if (isDevalueNativeValue(value)) return value;

  // A pending deferred value is settled on its own path, never walked here.
  if (isThenable(value)) return value;

  const jsonValue = value as { toJSON?: unknown; request?: Request };
  if (typeof jsonValue.toJSON === "function") {
    jsonValue.request = request;
    return (jsonValue.toJSON as () => unknown)();
  }

  if (Symbol.iterator in value) {
    const items = Array.from(value as Iterable<unknown>, (item) =>
      serializeLoaderData(item, request),
    );
    return items.some(isThenable) ? Promise.all(items) : items;
  }

  if (!isPlainObject(value)) return value;

  const serialized: Record<string, unknown> = {};
  const pending: Promise<void>[] = [];

  for (const key in value) {
    const item = serializeLoaderData(value[key], request);

    if (isThenable(item)) {
      // Reserve the slot now so key order matches the loader's object.
      serialized[key] = undefined;
      pending.push(
        Promise.resolve(item).then((resolved) => {
          serialized[key] = resolved;
        }),
      );
    } else {
      serialized[key] = item;
    }
  }

  return pending.length === 0 ? serialized : Promise.all(pending).then(() => serialized);
}
