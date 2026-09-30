import type { ReactNode } from "react";
import type { Response, Serialized } from "@warlock.js/core";
import type { SharedContext } from "./index";
import type { DeferredResult } from "./loaders/defer";

/** Any loader authored with `satisfies` — the concrete function type. */
export type LoaderFunction = (...args: any[]) => unknown;

/**
 * One top-level value of a `defer()` call's data, as the page reads it.
 *
 * A promise is a deferred value: the runtime serializes its SETTLED value, so
 * the type serializes `Awaited<V>` and keeps the promise-ness the page sees
 * (`use(data.reviews)`). Every other value is `Serialized<V, "devalue">`. A
 * raw `Promise` must never reach `Serialized` itself, which would map its
 * methods away.
 */
type SerializedDeferredValue<V> = V extends PromiseLike<unknown>
  ? Promise<Serialized<Awaited<V>, "devalue">>
  : Serialized<V, "devalue">;

/**
 * What survives `serializeLoaderData` + devalue for a loader's return value:
 * `Serialized<_, "devalue">`. A `defer()` result is unwrapped to its `data`
 * first and mapped key by key, because only its TOP-LEVEL keys may be promises
 * (see {@link SerializedDeferredValue}). `void` passes through unchanged (the
 * page reads `undefined`).
 */
type SerializedLoaderReturn<T> = T extends DeferredResult<infer TData>
  ? { -readonly [K in keyof TData]: SerializedDeferredValue<TData[K]> }
  : [T] extends [void]
    ? T
    : Serialized<T, "devalue">;

/**
 * What a page, layout or app component reads from its loader: the loader's
 * literal return shape minus core Response (returning that exact class is
 * terminal; every other value is data), after the same serialization the
 * pipeline applies, `Serialized<Return, "devalue">`: a registered cascade model
 * becomes its resource output, `Date`/`Map`/`Set`/`RegExp`/`URL` stay native,
 * functions are dropped, and a class instance without `toJSON` becomes
 * `never` (devalue throws on it at render). Metadata callbacks receive the
 * same value.
 */
export type LoaderData<TLoader> = TLoader extends LoaderFunction
  ? SerializedLoaderReturn<Exclude<Awaited<ReturnType<TLoader>>, Response>>
  : undefined;

/**
 * What the pipeline hands a page component: its own loader's data plus the
 * per-request payload. Never `request` or `response` — the component also
 * renders on a machine where neither exists.
 */
export type PageProps<TLoader extends LoaderFunction | undefined = undefined> = {
  data: LoaderData<TLoader>;
  shared: Readonly<SharedContext>;
  params: Readonly<Record<string, string>>;
};

/**
 * A layout additionally receives the subtree it wraps. Usable bare —
 * `LayoutProps` with no generic — for a layout with no loader
 * (main/web/layout.tsx:26).
 */
export type LayoutProps<TLoader extends LoaderFunction | undefined = undefined> = {
  data: LoaderData<TLoader>;
  shared: Readonly<SharedContext>;
  children: ReactNode;
};

/** The root component's props (root.tsx:76). */
export type AppProps<TLoader extends LoaderFunction | undefined = undefined> = {
  data: LoaderData<TLoader>;
  shared: Readonly<SharedContext>;
  children: ReactNode;
};

/**
 * Props passed only while the server renders an application `error.page.tsx`.
 * The thrown value intentionally remains intact here; its browser counterpart
 * is normalized at the hydration boundary.
 */
export type ServerErrorPageProps = {
  error: unknown;
  status: number;
};
