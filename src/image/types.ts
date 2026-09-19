import type { ImgHTMLAttributes } from "react";

/** Modern raster formats `<Image>` can offer via `<source>`, beside the default format. */
export type ImageFormat = "avif" | "webp";

/** One rendered size of an image, at the default format plus optionally others. */
export type ImageVariantDescriptor = {
  /** Rendered width of this variant, in pixels. */
  width: number;
  height?: number;
  /**
   * A pre-generated URL for the default format (S3/R2/CDN). When set, the
   * loader is NOT called for the default format on this variant.
   */
  url?: string;
  /** Pre-generated URLs per extra format, keyed by {@link ImageFormat}. */
  urls?: Partial<Record<ImageFormat, string>>;
};

/**
 * Plain, serializable description of an image and its available renditions —
 * safe to carry through loader data as JSON. Never carries a file handle, a
 * buffer or anything Sharp produced; only what `<Image>` needs to build
 * `srcSet`/`src` strings.
 */
export type ImageDescriptor = {
  /** The original source path, e.g. `"/uploads/posts/cover.jpg"`. */
  src: string;
  /** Intrinsic width of the original, in pixels. */
  width: number;
  /** Intrinsic height of the original, in pixels. */
  height: number;
  /** Finite, named set of renditions — keys are variant names, not widths. */
  variants: Readonly<Record<string, ImageVariantDescriptor>>;
  /** Extra modern formats to offer via `<source>`, in the order to render them. */
  formats?: readonly ImageFormat[];
};

/** What a loader receives to turn one variant (and optionally format) into a URL. */
export type ImageLoaderInput = {
  src: string;
  variant: string;
  width: number;
  format?: ImageFormat;
};

/** Turns an `ImageLoaderInput` into a URL string. */
export type ImageLoader = (input: ImageLoaderInput) => string;

export type ImageProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "srcSet" | "width" | "height" | "alt" | "loading" | "fetchPriority" | "sizes"
> & {
  image: ImageDescriptor;
  /** Required; pass `""` for a decorative image. */
  alt: string;
  /** Caller-owned `sizes` attribute. Defaults to `"100vw"`. */
  sizes?: string;
  /** `true` sets `loading="eager"` and `fetchPriority="high"`. Defaults to lazy. */
  priority?: boolean;
  /** Defaults to {@link warlockImageLoader}. */
  loader?: ImageLoader;
};
