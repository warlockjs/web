import type { SharedContext } from "./index";

/**
 * The runtime behind `shared` — the per-request, ALS-backed audit surface.
 *
 * `shared` is syntactically global for DX but semantically request-scoped: the
 * exported value is a Proxy, and EVERY trap re-resolves the current request's
 * target through core's AsyncLocalStorage store. This module holds a resolver,
 * never data — nothing here may cache a target, because a cached target
 * reintroduces the cross-request leak in the one form that still passes a
 * single-request test. And it throws rather than falling
 * back: outside a live request there is no process-wide object to land on —
 * that is `useRequestStore()`'s `|| {}` shape (request-context.ts:74-76),
 * deliberately not copied here; the pattern followed instead is
 * `requestMemo()`'s raw-store-or-throw (core/src/http/context/request-memo.ts:29-40).
 *
 * WHY A RESOLVER AND NOT `import { requestContext } from "@warlock.js/core"`:
 * web does not (and must not yet) depend on core — no core dep in
 * web/package.json, no tsconfig path, and no built esm/ in this checkout
 * (context.ts:96-98 records the same fact for types). So the PIPELINE, which
 * lives where `requestContext` is in scope, owns the wiring end to end:
 *
 *   connectSharedStore(() => requestContext.getStore());  // boot, once
 *   enterSharedScope(store);                              // stage 2, per request
 *   await sealShared();                                   // settle stage: gate → parse → freeze
 *
 * shared.ts never opens an ALS scope itself.
 */

/**
 * Untyped view of the per-request target. `SharedContext` declares the
 * framework keys (`can`, `locale`, `dir`, `nonce`) the pipeline's middleware
 * writes into the target before any app code reads them, so the runtime writes
 * through this shape and the public surface casts at the boundary — through
 * `unknown`, because the two types share no declared members.
 */
type SharedTarget = Record<string | symbol, unknown>;

/**
 * The pipeline's per-request store, structurally. At runtime this IS core's
 * `RequestContextStore` (`{ request, response }`, request-context.ts:10-13);
 * only `response.parse` is named here because it is the one member seal needs —
 * core's `Response.parse` is public (core/src/http/response.ts:297) and the
 * store already carries the instance, which is how seal reaches it without web
 * importing core.
 */
export interface SharedStore {
  response?: { parse(value: unknown): Promise<unknown> };
}

/**
 * Returns the CURRENT request's store, or undefined outside a request. The
 * pipeline connects `() => requestContext.getStore()`.
 */
export type SharedStoreResolver = () => SharedStore | undefined;

type SharedScope = {
  target: SharedTarget;
  sealed: boolean;
};

/**
 * Per-request scope records, keyed by the request's own store object — the
 * exact idiom of request-memo.ts:10: the store object is fresh per request
 * (RequestContext.buildStore), so two concurrent requests cannot share or even
 * see each other's entries, and everything is GC-eligible when the request's
 * ALS frame ends.
 */
const sharedScopes = new WeakMap<SharedStore, SharedScope>();

let resolveSharedStore: SharedStoreResolver | undefined;

/**
 * Boot-time wiring, called once by the pipeline before any request runs.
 * Returns the previously connected resolver so a caller (tests, mainly) can
 * restore it.
 */
export function connectSharedStore(
  resolve: SharedStoreResolver | undefined,
): SharedStoreResolver | undefined {
  const previous = resolveSharedStore;
  resolveSharedStore = resolve;
  return previous;
}

function currentStore(access: string): SharedStore {
  if (!resolveSharedStore) {
    throw new Error(
      `Cannot ${access}: \`shared\` is not connected to a request store ` +
        "(web/src/shared.ts). `shared` is request-scoped — its data lives in " +
        "core's per-request AsyncLocalStorage store, and this module holds only " +
        "a resolver, never data. Fix: the server bootstrap must call " +
        "connectSharedStore(() => requestContext.getStore()) before any request " +
        "runs; in a unit test, connect a resolver for the context the test runs in.",
    );
  }

  const store = resolveSharedStore();

  if (!store) {
    throw new Error(
      `Cannot ${access}: \`shared\` was accessed outside a request context ` +
        "(web/src/shared.ts). `shared` is per-request — this happens at module " +
        "load, in a background job, or from a late timer/dangling promise that " +
        "outlived its request. There is deliberately NO fallback to a " +
        "process-wide object: that would leak one user's data into another's " +
        "response. Fix: move this access into code the request pipeline runs " +
        "(middleware, a loader, a component render), or pass the value you need " +
        "explicitly.",
    );
  }

  return store;
}

function scopeOf(store: SharedStore, access: string): SharedScope {
  const scope = sharedScopes.get(store);

  if (!scope) {
    throw new Error(
      `Cannot ${access}: this request has no \`shared\` scope yet ` +
        "(web/src/shared.ts). The per-request target is created by the pipeline " +
        "at stage 2 via enterSharedScope(store); this access ran inside the " +
        "request context but before that point. Fix: move the access after " +
        "pipeline stage 2 (any middleware/loader/render code qualifies), or — if " +
        "you are the pipeline — call enterSharedScope(store) first.",
    );
  }

  return scope;
}

function requireScope(access: string): SharedScope {
  return scopeOf(currentStore(access), access);
}

function sealedWriteError(action: string, key: string | symbol): Error {
  return new Error(
    `Cannot ${action} \`shared.${String(key)}\`: shared is SEALED for this ` +
      "request (web/src/shared.ts). Writes are middleware work and happen " +
      "before the seal; after the seal the payload is committed to the page and " +
      "any further write would silently diverge server from client. Reads keep " +
      "working. Fix: move this write into middleware (before the pipeline's " +
      "seal stage), or if the value is render-time state, it does not belong in " +
      "`shared`.",
  );
}

/**
 * Pipeline stage 2: create THE per-request target. Once per request — the
 * store object is the request's identity (fresh per request), so a second call
 * for the same store is a pipeline bug, not a merge.
 *
 * Returns the raw target; the pipeline may hold it, but app code goes through
 * `shared`.
 */
export function enterSharedScope(store: SharedStore): SharedContext {
  if (sharedScopes.has(store)) {
    throw new Error(
      "enterSharedScope() was called twice for the same request store " +
        "(web/src/shared.ts). Each request gets exactly one `shared` target, " +
        "created once at pipeline stage 2. Fix: enter the scope once per " +
        "request; to reach the existing target, use `shared` inside the " +
        "request context instead.",
    );
  }

  const target: SharedTarget = {};

  sharedScopes.set(store, { target, sealed: false });

  return target as unknown as SharedContext;
}

function rejectAtGate(path: string, offender: string): never {
  throw new Error(
    `sealShared(): \`${path}\` is ${offender} (web/src/shared.ts prototype ` +
      "gate — runs in production AND dev). `shared` is the audit surface " +
      "serialized into the page: every value must be plain data (scalars, " +
      "arrays, plain objects) or carry a `toJSON()` serialization contract " +
      "(a Resource). A Date/Map/Set/class instance smuggles prototype state " +
      "past that audit and does not survive serialization intact. Fix: store " +
      "plain data — an ISO string instead of a Date, an object or array " +
      "instead of a Map/Set, a Resource (or its `.toJSON()` output) instead " +
      "of a model or class instance.",
  );
}

/**
 * The prototype gate. Precedence mirrors `Response.parse` exactly so the gate
 * and the normalization that follows it agree on every value: toJSON wins over
 * the plain-object branch (response.ts:301-305 vs :319) and is NOT descended —
 * a Resource's field list is its own contract. Date is
 * checked BEFORE toJSON because `Date.prototype.toJSON` exists and Dates are
 * rejected regardless.
 */
function assertClientSafe(value: unknown, path: string): void {
  if (value === null || value === undefined) return;

  const valueType = typeof value;

  if (valueType === "function") rejectAtGate(path, "a function");
  if (valueType !== "object") return;

  if (value instanceof Date) rejectAtGate(path, "a Date");
  if (value instanceof Map) rejectAtGate(path, "a Map");
  if (value instanceof Set) rejectAtGate(path, "a Set");

  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertClientSafe(item, `${path}[${index}]`));
    return;
  }

  const proto = Object.getPrototypeOf(value);

  if (proto === Object.prototype || proto === null) {
    for (const key of Object.keys(value)) {
      assertClientSafe((value as SharedTarget)[key], `${path}.${key}`);
    }
    return;
  }

  const name = (proto?.constructor?.name as string | undefined) ?? "unknown class";
  rejectAtGate(path, `a class instance (${name})`);
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;

  Object.freeze(value);

  for (const key of Object.keys(value)) {
    deepFreeze((value as SharedTarget)[key]);
  }
}

let browserSharedSnapshot: Readonly<SharedContext> | undefined;
let browserSharedInstalled = false;

function freezeBrowserSnapshot(value: object, seen: Set<object>): void {
  if (seen.has(value)) return;

  seen.add(value);

  for (const key of Object.keys(value)) {
    const child = (value as SharedTarget)[key];

    if (child !== null && typeof child === "object") {
      freezeBrowserSnapshot(child, seen);
    }
  }

  Object.freeze(value);
}

/**
 * Install the browser's one readonly `shared` snapshot. An object value is
 * recursively frozen in place and retained wholesale so every consumer
 * observes the same identity; this never reads or writes the server ALS scope.
 */
export function installBrowserSharedSnapshot(value: unknown): void {
  if (value !== null && typeof value === "object") {
    freezeBrowserSnapshot(value, new Set<object>());
  }

  browserSharedSnapshot = value as Readonly<SharedContext>;
  browserSharedInstalled = true;
}

/** Compatibility alias; browser snapshot ownership lives in the installer above. */
export function hydrateShared(value: unknown): void {
  installBrowserSharedSnapshot(value);
}

function readBrowserSharedSnapshot(): Readonly<SharedContext> {
  if (!browserSharedInstalled) {
    throw new Error(
      "Cannot read `shared` via useShared(): the browser snapshot has not been " +
        "installed (web/src/shared.ts). Hydration must validate the complete " +
        "#__WARLOCK_DATA__ payload and call installBrowserSharedSnapshot() " +
        "before constructing the React tree.",
    );
  }

  return browserSharedSnapshot as Readonly<SharedContext>;
}

/**
 * The settle-stage seal, exported for the pipeline. Order is load-bearing:
 *
 * 1. PROTOTYPE GATE (pre-parse) — production and dev, offending key named
 *    with its full path. Fail-fast courtesy: catches most violations before
 *    spending a parse pass on them.
 * 2. `Response.parse` NORMALIZATION — via the store's own response instance
 *    (core/src/http/response.ts:297, the public surface). parse mutates the
 *    target IN PLACE (response.ts:327), which is exactly why it MUST precede
 *    the freeze: freeze-then-parse throws on the first key parse writes
 *    in place.
 * 3. PROTOTYPE GATE AGAIN (post-parse) — closes the re-entry window the first
 *    gate cannot see: `Response.parse` never re-parses a `toJSON()` result
 *    (it only normalizes the value handed to it), so a Resource whose `toJSON()` returns a
 *    Date/Map/Set/class instance re-enters the payload AFTER the first gate
 *    already ran — the first gate inspects the pre-parse value (a plain
 *    object with a callable `toJSON`, correctly not descended) and parse then
 *    puts back exactly what that gate would have rejected. Only a gate that
 *    runs on the POST-parse target — the object that actually ships — can
 *    catch it. This is the only gate that matters for correctness; the first
 *    is a fail-fast courtesy that never gets to be wrong on its own.
 * 4. DEEP FREEZE — dev only (env read at seal time). Prod skips the freeze but
 *    NOT the sealed-write throw below; freezing is defense-in-depth for direct
 *    target references, the throw is the contract.
 * 5. Sealed flag — writes/deletes/defines through `shared` now throw naming
 *    the key; reads keep working.
 *
 * `store` defaults to the current request's store; the pipeline holds the
 * store either way, since it entered the scope with it. Returns the sealed
 * target — serialize THAT, not a re-read of the proxy.
 */
export async function sealShared(store?: SharedStore): Promise<Readonly<SharedContext>> {
  const scopeStore = store ?? currentStore("seal `shared`");
  const scope = scopeOf(scopeStore, "seal `shared`");

  if (scope.sealed) {
    throw new Error(
      "sealShared() was called twice for the same request (web/src/shared.ts). " +
        "The seal is the pipeline's settle stage and runs once, after " +
        "middleware writes and before serialization. Fix: seal once per " +
        "request.",
    );
  }

  assertClientSafe(scope.target, "shared");

  const response = scopeStore.response;

  if (!response || typeof response.parse !== "function") {
    throw new Error(
      "sealShared() found no `response.parse` on the request store " +
        "(web/src/shared.ts). Sealing normalizes `shared` through core's " +
        "public `Response.parse` (core/src/http/response.ts:297), reached via " +
        "the store's own `response` — the store the pipeline entered the scope " +
        "with must be core's request store (`{ request, response }`, " +
        "request-context.ts:10-13). Fix: pass that store (or run sealShared() " +
        "inside the request context that carries it).",
    );
  }

  await response.parse(scope.target);

  assertClientSafe(scope.target, "shared");

  if (import.meta.env.DEV) {
    deepFreeze(scope.target);
  }

  scope.sealed = true;

  return scope.target as Readonly<SharedContext>;
}

/**
 * The WRITABLE per-request payload — middleware's half of the contract.
 *
 * Every `shared.x = …` at a call site reads like a global write; it is not —
 * each trap below resolves the CURRENT request's target through the connected
 * store resolver, on every single access — two concurrent requests writing
 * `shared.locale` write to two different objects.
 */
export const shared: SharedContext = new Proxy({} as SharedTarget, {
  get(_stub, key) {
    return requireScope(`read \`shared.${String(key)}\``).target[key];
  },

  set(_stub, key, value) {
    const scope = requireScope(`write \`shared.${String(key)}\``);

    if (scope.sealed) throw sealedWriteError("write", key);

    scope.target[key] = value;

    return true;
  },

  has(_stub, key) {
    return key in requireScope(`check \`shared.${String(key)}\``).target;
  },

  deleteProperty(_stub, key) {
    const scope = requireScope(`delete \`shared.${String(key)}\``);

    if (scope.sealed) throw sealedWriteError("delete", key);

    delete scope.target[key];

    return true;
  },

  ownKeys() {
    return Reflect.ownKeys(requireScope("enumerate `shared`").target);
  },

  getOwnPropertyDescriptor(_stub, key) {
    const descriptor = Object.getOwnPropertyDescriptor(
      requireScope(`describe \`shared.${String(key)}\``).target,
      key,
    );

    if (!descriptor) return undefined;

    // The proxy's book-keeping target is the empty stub, so a frozen real
    // target's non-configurable descriptors would violate proxy invariants if
    // reported as-is; configurable:true is the honest report for the proxy
    // surface (the sealed-write throw is what enforces immutability).
    return { ...descriptor, configurable: true };
  },

  defineProperty(_stub, key, descriptor) {
    const scope = requireScope(`define \`shared.${String(key)}\``);

    if (scope.sealed) throw sealedWriteError("define", key);

    Reflect.defineProperty(scope.target, key, descriptor);

    return true;
  },
}) as unknown as SharedContext;

/**
 * The READ half for components at depth. On the server it preserves the live
 * ALS proxy behavior. In the browser it returns the exact recursively frozen
 * object installed from the validated hydration payload, never an empty or
 * process-wide fallback.
 */
export function useShared(): Readonly<SharedContext> {
  if (typeof window !== "undefined") return readBrowserSharedSnapshot();

  requireScope("read `shared` via useShared()");

  return shared as Readonly<SharedContext>;
}
