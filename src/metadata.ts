import type { SharedContext } from "./index";
import type { LoaderData, LoaderFunction } from "./props";

/**
 * What the `metadata` export may produce. The pipeline injects it into
 * `<head>` before the first byte; `<Head />` only decides placement.
 *
 * **Every member here is a member something READS.** The two renderers are
 * `components/head.ts:28-70` (the SSR'd document) and
 * `client/navigation/navigation-root.tsx:105-123` (the same head, rewritten
 * after a client navigation), and they agree key for key. This type is the list
 * of those keys and deliberately not one entry longer: a field the type promises
 * and no renderer consumes is the same silence as an unknown key — the page is
 * served without it and nothing says so.
 *
 * Adding a member is therefore a two-file change by construction. Add it here
 * and {@link METADATA_KEYS} stops matching, which is a compile error
 * ({@link MetadataKeysAreExact}); make it match and the build gate in
 * `build/discover-pages.ts` accepts the key — but until a renderer emits a tag
 * for it, the key still does nothing. Write the renderer.
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
 * The SAME key set as {@link MetadataOutput}, as a value.
 *
 * It exists because the defect this guards is one a type cannot reach.
 * `export const metadata = { tittle: "x" }` — no annotation — is a well-typed
 * program: TypeScript infers `{ tittle: string }` and has nothing to compare it
 * against, so the page is served with no title and the build says nothing. The
 * only place left to catch it is where pages are DISCOVERED, and discovery
 * refuses to run application code — it parses. A parser cannot ask a type what
 * its keys are, so the keys have to exist at runtime too.
 *
 * Two lists of one thing is exactly the drift this codebase refuses elsewhere,
 * so they are not two lists: {@link MetadataKeysAreExact} makes any
 * disagreement a compile error, in either direction. Add a key to the type
 * alone and this file stops compiling; add it here alone, likewise.
 */
export const METADATA_KEYS = [
  "title",
  "description",
  "keywords",
  "canonical",
  "robots",
  "openGraph",
  "twitter",
] as const;

/** The members of `openGraph`, on the same terms as {@link METADATA_KEYS}. */
export const OPEN_GRAPH_KEYS = ["title", "description", "image", "url", "type"] as const;

/** The members of `twitter`, on the same terms as {@link METADATA_KEYS}. */
export const TWITTER_KEYS = ["card", "title", "description", "image"] as const;

/**
 * Instantiates only when `Difference` is empty. When it is not, the compiler
 * names the offending key in the error — "Type '\"tittle\"' does not satisfy
 * the constraint 'never'" — which is the whole message a drift needs.
 *
 * A mutual `extends` (`Exactly<A extends B, B extends A>`) says the same thing
 * more directly and TypeScript rejects it as a circular constraint (TS2313), so
 * the sets are compared by difference instead, once in each direction. BOTH
 * directions matter: a list that has fallen behind the type makes the build gate
 * reject a key it should accept, and a list that has run ahead makes it accept
 * one nothing renders.
 */
type NoDifference<Difference extends never> = Difference;

/**
 * The drift guards, written out per key set rather than through one generic
 * helper: a `SameKeys<List, Keys>` alias would apply `NoDifference` to an
 * UNRESOLVED `Exclude<List, Keys>`, which the compiler cannot show is empty and
 * so rejects at the declaration (TS2344) whatever the real key sets are. Passed
 * concrete types, it resolves and checks the thing it is meant to check.
 *
 * Exported so they are not "unused", and named so a failure reads as what it
 * is: the key list and the type have diverged.
 */
export type MetadataKeysAreExact = [
  NoDifference<Exclude<(typeof METADATA_KEYS)[number], keyof MetadataOutput>>,
  NoDifference<Exclude<keyof MetadataOutput, (typeof METADATA_KEYS)[number]>>,
];

type OpenGraphKey = keyof NonNullable<MetadataOutput["openGraph"]>;

export type OpenGraphKeysAreExact = [
  NoDifference<Exclude<(typeof OPEN_GRAPH_KEYS)[number], OpenGraphKey>>,
  NoDifference<Exclude<OpenGraphKey, (typeof OPEN_GRAPH_KEYS)[number]>>,
];

type TwitterKey = keyof NonNullable<MetadataOutput["twitter"]>;

export type TwitterKeysAreExact = [
  NoDifference<Exclude<(typeof TWITTER_KEYS)[number], TwitterKey>>,
  NoDifference<Exclude<TwitterKey, (typeof TWITTER_KEYS)[number]>>,
];

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
