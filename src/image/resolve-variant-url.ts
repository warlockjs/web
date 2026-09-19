import type { ImageFormat, ImageLoader, ImageVariantDescriptor } from "./types";

/**
 * The URL for one variant at the default format: the pre-generated `url`
 * when set, otherwise the loader's output. The loader is never called when a
 * pre-generated `url` is present.
 */
export function resolveDefaultVariantUrl(
  src: string,
  name: string,
  descriptor: ImageVariantDescriptor,
  loader: ImageLoader,
): string {
  return descriptor.url ?? loader({ src, variant: name, width: descriptor.width });
}

/**
 * The URL for one variant at an extra `format`: the pre-generated
 * `urls[format]` when set, otherwise the loader's output. The loader is
 * never called when a pre-generated URL is present.
 */
export function resolveFormatVariantUrl(
  src: string,
  name: string,
  descriptor: ImageVariantDescriptor,
  format: ImageFormat,
  loader: ImageLoader,
): string {
  return (
    descriptor.urls?.[format] ?? loader({ src, variant: name, width: descriptor.width, format })
  );
}
