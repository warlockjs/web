import { createElement } from "react";
import type { ReactElement } from "react";
import type { ImageProps } from "./types";
import { buildDefaultSrcSet, buildFormatSrcSet } from "./build-image-src-set";
import { resolveDefaultVariantUrl } from "./resolve-variant-url";
import { sortImageVariants } from "./sort-image-variants";
import { warlockImageLoader } from "./warlock-image-loader";
import { warnMissingAlt } from "./warn-missing-alt";

/**
 * The universal `<Image>` component — renders `srcSet`/`src` (and, with
 * `image.formats`, a `<picture>` of `<source>`s) from a plain
 * {@link ImageProps.image} descriptor.
 *
 * A pure render with no effects and no state: given the same descriptor and
 * props, the server and the client produce byte-identical markup, so
 * hydration matches by construction. It NEVER runs Sharp, inspects a file or
 * imports server-only code — every URL either comes off the descriptor
 * verbatim or is built by `loader`, a plain string function.
 */
export function Image(props: ImageProps): ReactElement {
  const {
    image,
    alt,
    sizes = "100vw",
    priority = false,
    loader = warlockImageLoader,
    ...rest
  } = props;

  warnMissingAlt(image.src, alt);

  const variants = sortImageVariants(image.variants);
  const largest = variants[variants.length - 1];
  const fallbackSrc = largest
    ? resolveDefaultVariantUrl(image.src, largest.name, largest.descriptor, loader)
    : image.src;

  const imgElement = createElement("img", {
    ...rest,
    src: fallbackSrc,
    srcSet: variants.length > 0 ? buildDefaultSrcSet(image.src, variants, loader) : undefined,
    width: image.width,
    height: image.height,
    sizes,
    alt,
    decoding: "async",
    loading: priority ? "eager" : "lazy",
    fetchPriority: priority ? "high" : undefined,
  });

  const formats = image.formats ?? [];
  if (formats.length === 0) {
    return imgElement;
  }

  const sources = formats.map((format) =>
    createElement("source", {
      key: format,
      type: `image/${format}`,
      srcSet: buildFormatSrcSet(image.src, variants, format, loader),
      sizes,
    }),
  );

  return createElement("picture", null, ...sources, imgElement);
}
