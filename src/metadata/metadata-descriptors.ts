import type { MetadataOutput } from "../metadata";

/** Attribute names as written in the DOM (lowercase) — the allowlist for `metadata.links`. */
export type LinkAttributes = {
  rel: string;
  href: string;
  hreflang?: string;
  type?: string;
  sizes?: string;
  media?: string;
  as?: string;
  crossorigin?: string;
  title?: string;
};

/**
 * ONE tag `<Head/>` renders and the client navigation applier writes,
 * described the same way regardless of which side is consuming it. `title`
 * carries its text directly; `meta`/`link` carry the attribute pair the
 * element is addressed and written by.
 *
 * `dynamic` marks tags whose slots are not a fixed list — those from
 * `metadata.meta` / `metadata.links` and the repeatable built-ins (images,
 * article tags/authors, alternate locales, author links). See
 * {@link MANAGED_DYNAMIC_ATTRIBUTE}.
 */
export type MetadataDescriptor =
  | { kind: "title"; key: "title"; attrs: { value: string } }
  | {
      kind: "meta";
      key: string;
      attrs: { attribute: "name" | "property" | "http-equiv"; name: string; content: string };
      dynamic?: true;
    }
  | { kind: "link"; key: string; attrs: LinkAttributes; dynamic?: true };

/**
 * Written on every dynamic tag (value: the descriptor key), by `<Head/>` and by
 * the client applier alike. It is how the client tells framework-managed dynamic
 * tags from tags root.tsx wrote, which it never touches.
 */
export const MANAGED_DYNAMIC_ATTRIBUTE = "data-warlock-metadata";

/**
 * The FULL, ordered set of FIXED tag slots `<Head/>` and the client navigation
 * applier manage — present or not, and each one doubles as the CSS selector
 * that finds it in a live document. {@link resolveMetadataDescriptors} only
 * returns the slots the current metadata fills; the applier still needs every
 * slot to know which ones to remove when a navigation's metadata does not
 * fill them (`client/navigation/document-metadata.ts`'s "ABSENT MEANS
 * REMOVED").
 *
 * Repeatable tags (`og:image*`, `article:tag`, `article:author`,
 * `og:locale:alternate`, `link rel=author`) are NOT here: they are dynamic.
 *
 * These are also the keys `metadata.meta` / `metadata.links` may not use: the
 * built-in field wins.
 */
export const MANAGED_METADATA_KEYS = [
  "title",
  'meta[name="description"]',
  'meta[name="keywords"]',
  'meta[name="author"]',
  'link[rel="canonical"]',
  'meta[name="robots"]',
  'meta[property="og:title"]',
  'meta[property="og:description"]',
  'meta[property="og:url"]',
  'meta[property="og:type"]',
  'meta[property="og:site_name"]',
  'meta[property="og:locale"]',
  'meta[property="article:published_time"]',
  'meta[property="article:modified_time"]',
  'meta[property="article:section"]',
  'meta[name="twitter:card"]',
  'meta[name="twitter:title"]',
  'meta[name="twitter:description"]',
  'meta[name="twitter:image"]',
  'meta[name="twitter:image:alt"]',
  'meta[name="twitter:site"]',
  'meta[name="twitter:creator"]',
] as const;

/**
 * Built-in tags that can repeat. Each occurrence is a dynamic descriptor keyed
 * `<selector>#<ordinal>`; the bare selectors are still reserved, so
 * `metadata.meta` may not address them.
 */
const DYNAMIC_BUILT_IN_KEYS = [
  'meta[property="og:image"]',
  'meta[property="og:image:width"]',
  'meta[property="og:image:height"]',
  'meta[property="og:image:alt"]',
  'meta[property="og:image:type"]',
  'meta[property="og:locale:alternate"]',
  'meta[property="article:author"]',
  'meta[property="article:tag"]',
] as const;

const RESERVED_KEYS: ReadonlySet<string> = new Set([
  ...MANAGED_METADATA_KEYS,
  ...DYNAMIC_BUILT_IN_KEYS,
]);

const REL_PATTERN = /^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$/i;

const HTTP_EQUIV_VALUES: readonly string[] = [
  "content-type",
  "default-style",
  "x-ua-compatible",
  "content-security-policy",
];

const LINK_OPTIONAL_ATTRIBUTES = ["hreflang", "type", "sizes", "media", "as", "title"] as const;

function warnDropped(what: string, reason: string): void {
  if (import.meta.env?.DEV) {
    console.warn(`[warlock] metadata: dropped ${what} — ${reason}.`);
  }
}

/** Escapes a value for use inside a double-quoted CSS attribute selector. */
function selectorValue(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/** `javascript:` after the whitespace/control characters a browser ignores while parsing a scheme. */
function isJavascriptUrl(href: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^javascript:/i.test(href.replace(/[\u0000-\u0020]/g, ""));
}

function metaDescriptor(
  attribute: "name" | "property" | "http-equiv",
  name: string,
  content: string | undefined,
): MetadataDescriptor | undefined {
  if (content === undefined) return undefined;

  return {
    kind: "meta",
    key: `meta[${attribute}="${name}"]`,
    attrs: { attribute, name, content },
  };
}

/** One occurrence of a repeatable built-in tag, keyed `<selector>#<ordinal>`. */
function repeatedMeta(
  name: string,
  ordinal: number,
  content: string | number | undefined,
): MetadataDescriptor[] {
  if (content === undefined) return [];

  return [
    {
      kind: "meta",
      key: `meta[property="${name}"]#${ordinal}`,
      attrs: { attribute: "property", name, content: String(content) },
      dynamic: true,
    },
  ];
}

type ImageObject = { url: string; width?: number; height?: number; alt?: string; type?: string };

function normalizeImages(
  value: string | ImageObject | readonly (string | ImageObject)[] | undefined,
): ImageObject[] {
  if (value === undefined) return [];

  const list: (string | ImageObject)[] = Array.isArray(value)
    ? [...value]
    : [value as string | ImageObject];

  return list
    .map((image) => (typeof image === "string" ? { url: image } : image))
    .filter((image) => typeof image.url === "string" && image.url !== "");
}

function normalizeAuthors(value: MetadataOutput["authors"]): { name: string; url?: string }[] {
  if (value === undefined) return [];

  const list = typeof value === "string" ? [value] : [...value];

  return list
    .map((author) => (typeof author === "string" ? { name: author } : author))
    .filter((author) => typeof author.name === "string" && author.name !== "");
}

function dynamicMetaDescriptors(entries: MetadataOutput["meta"]): MetadataDescriptor[] {
  const result: MetadataDescriptor[] = [];
  const seen = new Set<string>();

  for (const entry of entries ?? []) {
    const raw = entry as {
      name?: unknown;
      property?: unknown;
      httpEquiv?: unknown;
      content?: unknown;
    };
    const attribute =
      typeof raw.name === "string"
        ? "name"
        : typeof raw.property === "string"
          ? "property"
          : typeof raw.httpEquiv === "string"
            ? "http-equiv"
            : undefined;
    const name = (raw.name ?? raw.property ?? raw.httpEquiv) as string | undefined;

    if (attribute === undefined || name === undefined || typeof raw.content !== "string") {
      warnDropped("a `meta` entry", "it needs one of name / property / httpEquiv, and content");
      continue;
    }

    if (attribute === "http-equiv" && !HTTP_EQUIV_VALUES.includes(name)) {
      warnDropped(`meta http-equiv="${name}"`, "not an allowed http-equiv value");
      continue;
    }

    const key = `meta[${attribute}="${selectorValue(name)}"]`;

    if (RESERVED_KEYS.has(key)) {
      warnDropped(`meta ${key}`, "a built-in metadata field owns that tag");
      continue;
    }

    if (seen.has(key)) continue;
    seen.add(key);

    result.push({
      kind: "meta",
      key,
      attrs: { attribute, name, content: raw.content },
      dynamic: true,
    });
  }

  return result;
}

function dynamicLinkDescriptors(entries: MetadataOutput["links"]): MetadataDescriptor[] {
  const result: MetadataDescriptor[] = [];
  const seen = new Set<string>();

  for (const entry of entries ?? []) {
    const { rel, href } = entry as { rel?: unknown; href?: unknown };

    if (typeof rel !== "string" || !REL_PATTERN.test(rel)) {
      warnDropped(`link rel=${JSON.stringify(rel)}`, "invalid rel");
      continue;
    }

    if (typeof href !== "string" || href === "" || isJavascriptUrl(href)) {
      warnDropped(`link rel="${rel}"`, "href is missing or uses the javascript: scheme");
      continue;
    }

    if (rel.toLowerCase().split(" ").includes("canonical")) {
      warnDropped(`link rel="${rel}"`, "use the `canonical` metadata field");
      continue;
    }

    const attrs: LinkAttributes = { rel, href };

    for (const name of LINK_OPTIONAL_ATTRIBUTES) {
      const value = entry[name];

      if (typeof value === "string") attrs[name] = value;
    }

    if (entry.crossOrigin === "anonymous" || entry.crossOrigin === "use-credentials") {
      attrs.crossorigin = entry.crossOrigin;
    }

    const key =
      `link[rel="${selectorValue(rel)}"][href="${selectorValue(href)}"]` +
      (attrs.hreflang === undefined ? "" : `[hreflang="${selectorValue(attrs.hreflang)}"]`);

    if (seen.has(key)) continue;
    seen.add(key);

    result.push({ kind: "link", key, attrs, dynamic: true });
  }

  return result;
}

/**
 * `PageMetadata`'s resolved output, turned into the ORDERED list of
 * descriptors a page actually sets. This is the single rule set, and it is
 * context-free — request-aware values (auto canonical, absolute URLs, locale)
 * are filled in beforehand by `enrichMetadata`. Anything a page sets explicitly
 * wins over a fallback:
 *
 * - `og:title`/`og:description` ← `openGraph.*` ?? the top-level field, ALWAYS
 *   (not only when `openGraph` is present);
 * - `og:image*` ← `openGraph.images` ?? `openGraph.image` ?? `image`;
 * - `og:type` ← `"website"` whenever any `og:*` tag is emitted;
 * - `article:*` only when the type is `"article"`;
 * - `authors` → `<meta name="author">` plus a `<link rel="author">` per URL;
 * - `twitter:*` ← `twitter.*` ?? the og value; `twitter:card` is
 *   `summary_large_image` with an image and `summary` without, emitted only
 *   when some og/twitter tag exists.
 *
 * `meta` / `links` entries follow the built-in tags, one descriptor each. An
 * entry that collides with a built-in slot, has a malformed `rel`, a
 * `javascript:` href or a disallowed `http-equiv` is dropped with a dev warning.
 *
 * A field the metadata does not set produces no descriptor here — see
 * {@link MANAGED_METADATA_KEYS} for the full slot list a consumer needs to
 * know what to remove.
 */
export function resolveMetadataDescriptors(
  metadata: MetadataOutput | undefined,
): MetadataDescriptor[] {
  const keywords =
    metadata?.keywords === undefined
      ? undefined
      : Array.isArray(metadata.keywords)
        ? metadata.keywords.join(", ")
        : (metadata.keywords as string);

  const openGraph = metadata?.openGraph;
  const twitter = metadata?.twitter;

  const ogTitle = openGraph?.title ?? metadata?.title;
  const ogDescription = openGraph?.description ?? metadata?.description;
  const images = normalizeImages(openGraph?.images ?? openGraph?.image ?? metadata?.image);
  const alternateLocales = openGraph?.alternateLocales ?? [];
  const authors = normalizeAuthors(metadata?.authors);

  const anyOpenGraph =
    ogTitle !== undefined ||
    ogDescription !== undefined ||
    images.length > 0 ||
    openGraph?.url !== undefined ||
    openGraph?.type !== undefined ||
    openGraph?.siteName !== undefined ||
    openGraph?.locale !== undefined ||
    alternateLocales.length > 0 ||
    openGraph?.article !== undefined;

  const ogType = anyOpenGraph ? (openGraph?.type ?? "website") : undefined;
  const article = ogType === "article" ? openGraph?.article : undefined;

  const hasTwitterField = twitter !== undefined && Object.keys(twitter).length > 0;
  const hasImage = images.length > 0 || twitter?.image !== undefined;
  const twitterCard =
    anyOpenGraph || hasTwitterField
      ? (twitter?.card ?? (hasImage ? "summary_large_image" : "summary"))
      : undefined;
  const twitterActive = twitterCard !== undefined;

  const descriptors: (MetadataDescriptor | undefined)[] = [
    metadata?.title !== undefined
      ? { kind: "title", key: "title", attrs: { value: metadata.title } }
      : undefined,
    metaDescriptor("name", "description", metadata?.description),
    metaDescriptor("name", "keywords", keywords),
    metaDescriptor(
      "name",
      "author",
      authors.length > 0 ? authors.map((author) => author.name).join(", ") : undefined,
    ),
    typeof metadata?.canonical === "string"
      ? {
          kind: "link",
          key: 'link[rel="canonical"]',
          attrs: { rel: "canonical", href: metadata.canonical },
        }
      : undefined,
    metaDescriptor("name", "robots", metadata?.robots),
    metaDescriptor("property", "og:title", ogTitle),
    metaDescriptor("property", "og:description", ogDescription),
    metaDescriptor("property", "og:url", openGraph?.url),
    metaDescriptor("property", "og:type", ogType),
    metaDescriptor("property", "og:site_name", openGraph?.siteName),
    metaDescriptor("property", "og:locale", openGraph?.locale),
    metaDescriptor("property", "article:published_time", article?.publishedTime),
    metaDescriptor("property", "article:modified_time", article?.modifiedTime),
    metaDescriptor("property", "article:section", article?.section),
    metaDescriptor("name", "twitter:card", twitterCard),
    metaDescriptor(
      "name",
      "twitter:title",
      twitterActive ? (twitter?.title ?? ogTitle) : undefined,
    ),
    metaDescriptor(
      "name",
      "twitter:description",
      twitterActive ? (twitter?.description ?? ogDescription) : undefined,
    ),
    metaDescriptor(
      "name",
      "twitter:image",
      twitterActive ? (twitter?.image ?? images[0]?.url) : undefined,
    ),
    metaDescriptor(
      "name",
      "twitter:image:alt",
      twitterActive ? (twitter?.imageAlt ?? images[0]?.alt) : undefined,
    ),
    metaDescriptor("name", "twitter:site", twitter?.site),
    metaDescriptor("name", "twitter:creator", twitter?.creator),
  ];

  // Repeatable built-ins. An image's sub-properties directly follow its
  // `og:image`, the order the Open Graph protocol asks for.
  const repeated: MetadataDescriptor[] = [];

  images.forEach((image, ordinal) => {
    repeated.push(
      ...repeatedMeta("og:image", ordinal, image.url),
      ...repeatedMeta("og:image:width", ordinal, image.width),
      ...repeatedMeta("og:image:height", ordinal, image.height),
      ...repeatedMeta("og:image:alt", ordinal, image.alt),
      ...repeatedMeta("og:image:type", ordinal, image.type),
    );
  });

  alternateLocales.forEach((locale, ordinal) => {
    repeated.push(...repeatedMeta("og:locale:alternate", ordinal, locale));
  });

  (article?.authors ?? []).forEach((author, ordinal) => {
    repeated.push(...repeatedMeta("article:author", ordinal, author));
  });

  (article?.tags ?? []).forEach((tag, ordinal) => {
    repeated.push(...repeatedMeta("article:tag", ordinal, tag));
  });

  const authorLinks: MetadataDescriptor[] = [];

  authors.forEach((author, ordinal) => {
    if (author.url === undefined || author.url === "" || isJavascriptUrl(author.url)) return;

    authorLinks.push({
      kind: "link",
      key: `link[rel="author"]#${ordinal}`,
      attrs: { rel: "author", href: author.url },
      dynamic: true,
    });
  });

  return [
    ...descriptors.filter(
      (descriptor): descriptor is MetadataDescriptor => descriptor !== undefined,
    ),
    ...repeated,
    ...authorLinks,
    ...dynamicMetaDescriptors(metadata?.meta),
    ...dynamicLinkDescriptors(metadata?.links),
  ];
}
