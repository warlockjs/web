/**
 * The request-aware half of the metadata fallbacks: everything that needs the
 * public origin, the request path or the locale, and so cannot live in the
 * context-free `resolveMetadataDescriptors`.
 *
 * Pure, and called ONCE on the server where the page's metadata is finalized
 * (`render-page.ts`'s `finishRender`), so the SSR'd `<head>` and the metadata
 * the client navigation payload carries are the same enriched object. Anything
 * the page set explicitly always wins.
 *
 * The URL join is `@warlock.js/sitemap`'s `joinOrigin`, the same rule
 * `resolve-locale-alternates.ts` uses.
 */
import { joinOrigin } from "@warlock.js/sitemap";
import type { MetadataImage, MetadataOutput } from "../metadata";

export type EnrichMetadataContext = {
  /** `getPublicUrl()`: without it nothing is absolutized and no canonical is derived. */
  publicUrl?: string;
  /** The path as served, locale prefix included. Query string and hash are ignored. */
  requestPath: string;
  /** The request's locale code (`en-US`, `ar`). */
  locale?: string;
  /** Every locale code of the page's hreflang set — the current one and `x-default` are excluded. */
  alternateLocales?: readonly string[];
};

/** `en-US` → `en_US`, `ar` stays `ar` — the form Open Graph expects. */
function formatOgLocale(code: string): string {
  return code.replace(/-/g, "_");
}

function pathnameOf(requestPath: string): string {
  const [pathname = "/"] = (requestPath || "/").split(/[?#]/);

  return pathname === "" ? "/" : pathname;
}

/** Only root-relative paths are joined; `//host/x` and absolute URLs are left alone. */
function absolutize(publicUrl: string | undefined, url: string): string {
  if (publicUrl === undefined || publicUrl === "") return url;
  if (!url.startsWith("/") || url.startsWith("//")) return url;

  return joinOrigin(publicUrl, url);
}

function absolutizeImage(publicUrl: string | undefined, image: string | MetadataImage) {
  return typeof image === "string"
    ? absolutize(publicUrl, image)
    : { ...image, url: absolutize(publicUrl, image.url) };
}

function isNoindex(robots: string | undefined): boolean {
  return robots !== undefined && /\bnoindex\b/i.test(robots);
}

export function enrichMetadata(
  metadata: MetadataOutput | undefined,
  context: EnrichMetadataContext,
): MetadataOutput | undefined {
  if (metadata === undefined) return undefined;

  // A noindex page (the error page, the not-found page) is not a page to
  // describe or share: it never gets a derived canonical, og:url or locale.
  if (isNoindex(metadata.robots)) return metadata;

  const publicUrl = context.publicUrl === "" ? undefined : context.publicUrl;
  const result: MetadataOutput = { ...metadata };
  const openGraph: NonNullable<MetadataOutput["openGraph"]> = { ...metadata.openGraph };

  // Canonical.
  let canonical: string | undefined;

  if (metadata.canonical === false) {
    delete result.canonical;
  } else if (typeof metadata.canonical === "string") {
    canonical = absolutize(publicUrl, metadata.canonical);
    result.canonical = canonical;
  } else if (publicUrl !== undefined) {
    canonical = joinOrigin(publicUrl, pathnameOf(context.requestPath));
    result.canonical = canonical;
  }

  if (openGraph.url !== undefined) {
    openGraph.url = absolutize(publicUrl, openGraph.url);
  } else if (canonical !== undefined) {
    openGraph.url = canonical;
  }

  // Images: every place a page can put one.
  if (result.image !== undefined) result.image = absolutizeImage(publicUrl, result.image);
  if (openGraph.image !== undefined) openGraph.image = absolutize(publicUrl, openGraph.image);
  if (openGraph.images !== undefined) {
    openGraph.images = openGraph.images.map(
      (image) => absolutizeImage(publicUrl, image) as MetadataImage,
    );
  }
  if (metadata.twitter?.image !== undefined) {
    result.twitter = { ...metadata.twitter, image: absolutize(publicUrl, metadata.twitter.image) };
  }

  // Locale. An explicit `openGraph.locale` is written as the page wrote it.
  if (openGraph.locale === undefined && context.locale !== undefined && context.locale !== "") {
    openGraph.locale = formatOgLocale(context.locale);
  }

  if (openGraph.alternateLocales === undefined && context.alternateLocales !== undefined) {
    const current = context.locale === undefined ? undefined : formatOgLocale(context.locale);
    const alternates = [
      ...new Set(
        context.alternateLocales
          .filter((code) => code !== "x-default")
          .map(formatOgLocale)
          .filter((code) => code !== current),
      ),
    ];

    if (alternates.length > 0) openGraph.alternateLocales = alternates;
  }

  // A page with nothing to say about Open Graph and no derived value stays as it was.
  if (Object.keys(openGraph).length > 0) result.openGraph = openGraph;

  return result;
}
