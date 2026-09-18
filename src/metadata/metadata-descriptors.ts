import type { MetadataOutput } from "../metadata";

/**
 * ONE tag `<Head/>` renders and the client navigation applier writes,
 * described the same way regardless of which side is consuming it. `title`
 * carries its text directly; `meta`/`link` carry the attribute pair the
 * element is addressed and written by.
 */
export type MetadataDescriptor =
  | { kind: "title"; key: "title"; attrs: { value: string } }
  | {
      kind: "meta";
      key: string;
      attrs: { attribute: "name" | "property"; name: string; content: string };
    }
  | { kind: "link"; key: 'link[rel="canonical"]'; attrs: { rel: "canonical"; href: string } };

/**
 * The FULL, ordered set of tag slots `<Head/>` and the client navigation
 * applier manage — present or not, and each one doubles as the CSS selector
 * that finds it in a live document. {@link resolveMetadataDescriptors} only
 * returns the slots the current metadata fills; the applier still needs every
 * slot to know which ones to remove when a navigation's metadata does not
 * fill them (`client/navigation/document-metadata.ts`'s "ABSENT MEANS
 * REMOVED").
 */
export const MANAGED_METADATA_KEYS = [
  "title",
  'meta[name="description"]',
  'meta[name="keywords"]',
  'link[rel="canonical"]',
  'meta[name="robots"]',
  'meta[property="og:title"]',
  'meta[property="og:description"]',
  'meta[property="og:image"]',
  'meta[property="og:url"]',
  'meta[property="og:type"]',
  'meta[name="twitter:card"]',
  'meta[name="twitter:title"]',
  'meta[name="twitter:description"]',
  'meta[name="twitter:image"]',
] as const;

function metaDescriptor(
  attribute: "name" | "property",
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

/**
 * `PageMetadata`'s resolved output, turned into the ORDERED list of
 * descriptors a page actually sets. This is the single rule set: `og:title`/
 * `og:description` fall back to the top-level `title`/`description` only
 * when `openGraph` is present (`metadata.ts`'s doc on {@link MetadataOutput});
 * no other member has a fallback, including `twitter`, which does NOT fall
 * back to `openGraph`.
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

  const ogTitle = openGraph !== undefined ? (openGraph.title ?? metadata?.title) : undefined;
  const ogDescription =
    openGraph !== undefined ? (openGraph.description ?? metadata?.description) : undefined;

  const descriptors: (MetadataDescriptor | undefined)[] = [
    metadata?.title !== undefined
      ? { kind: "title", key: "title", attrs: { value: metadata.title } }
      : undefined,
    metaDescriptor("name", "description", metadata?.description),
    metaDescriptor("name", "keywords", keywords),
    metadata?.canonical !== undefined
      ? {
          kind: "link",
          key: 'link[rel="canonical"]',
          attrs: { rel: "canonical", href: metadata.canonical },
        }
      : undefined,
    metaDescriptor("name", "robots", metadata?.robots),
    metaDescriptor("property", "og:title", ogTitle),
    metaDescriptor("property", "og:description", ogDescription),
    metaDescriptor("property", "og:image", openGraph?.image),
    metaDescriptor("property", "og:url", openGraph?.url),
    metaDescriptor("property", "og:type", openGraph?.type),
    metaDescriptor("name", "twitter:card", twitter?.card),
    metaDescriptor("name", "twitter:title", twitter?.title),
    metaDescriptor("name", "twitter:description", twitter?.description),
    metaDescriptor("name", "twitter:image", twitter?.image),
  ];

  return descriptors.filter(
    (descriptor): descriptor is MetadataDescriptor => descriptor !== undefined,
  );
}
