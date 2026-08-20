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
};

/**
 * Static object OR a function of the loader's data (products.page.tsx:81-84,
 * product-details.page.tsx:71-74). The function form runs server-side, after
 * the loader, with the same `data` the component will receive — which is why
 * it can describe the page instead of guessing at it.
 */
export type PageMetadata<TLoader extends LoaderFunction | undefined = undefined> =
  | MetadataOutput
  | ((context: {
      data: LoaderData<TLoader>;
      shared: Readonly<SharedContext>;
    }) => MetadataOutput);
