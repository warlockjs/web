import type { ReactNode } from "react";
import type { Response } from "@warlock.js/core";
import type { SharedContext } from "./index";

/** Any loader authored with `satisfies` — the concrete function type. */
export type LoaderFunction = (...args: any[]) => unknown;

/**
 * The loader's literal return shape minus core Response. Returning that exact
 * class is terminal; every other value is data.
 */
export type LoaderData<TLoader> = TLoader extends LoaderFunction
  ? Exclude<Awaited<ReturnType<TLoader>>, Response>
  : undefined;

/**
 * What the pipeline hands a page component: its own loader's data plus the
 * per-request payload. Never `request` or `response` — the component also
 * renders on a machine where neither exists.
 */
export type PageProps<TLoader extends LoaderFunction | undefined = undefined> = {
  data: LoaderData<TLoader>;
  shared: Readonly<SharedContext>;
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
