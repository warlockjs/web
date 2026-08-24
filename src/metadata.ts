import type { SharedContext } from "./index";
import type { LoaderData, LoaderFunction } from "./props";

/**
 * What the `metadata` export may produce. The pipeline injects it into
 * `<head>` before the first byte; `<Head />` only decides placement.
 */
export type MetadataOutput = {
  title?: string;
  description?: string;
  keywords?: string | readonly string[];
  canonical?: string;
  robots?: string;
  /**
   * `og:title`/`og:description` fall back to the top-level `title`/
   * `description` when `openGraph` is present but the member is absent —
   * no other member has a fallback.
   */
  openGraph?: {
    title?: string;
    description?: string;
    image?: string;
    url?: string;
    type?: string;
  };
  twitter?: {
    card?: string;
    title?: string;
    description?: string;
    image?: string;
  };
};

/**
 * Static object OR a function of the loader's data (products.page.tsx:81-84,
 * product-details.page.tsx:71-74). The function form runs server-side, after
 * the loader, with the same `data` the component will receive — which is why
 * it can describe the page instead of guessing at it.
 *
 * **`data` is always present, and that is now true rather than merely
 * declared.** The function form runs only when the loader resolved; when it
 * rejected, the framework emits `ERROR_PAGE_METADATA` and this never runs
 * (`server/resolve-page-metadata.ts`, which explains why at length). An earlier
 * revision passed `{ data: undefined, error }` on the boundary path while
 * declaring `data` non-optional — every page that read `data` unguarded then
 * threw a `TypeError` that replaced the loader's real error.
 */
export type PageMetadata<TLoader extends LoaderFunction | undefined = undefined> =
  | MetadataOutput
  | ((context: {
      data: LoaderData<TLoader>;
      shared: Readonly<SharedContext>;
    }) => MetadataOutput);
