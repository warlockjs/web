---
name: render-images
description: 'Render responsive, CLS-safe images with the `<Image>` component from `@warlock.js/web`: pass a plain `ImageDescriptor` (`src`, `width`, `height`, named `variants`, optional `formats`) and get `srcSet`, `sizes`, intrinsic `width`/`height`, lazy loading and an optional `<picture>` of avif/webp sources, identical on the server and in the browser. Covers `alt`, `sizes`, `priority` for the LCP image, the default `warlockImageLoader` (`?variant=` URLs served by core''s `uploadedFileController`), a custom `loader` for a CDN, and producing descriptors with `generateImageVariants` and `uploads.images`. Triggers: `Image`, `ImageDescriptor`, `ImageProps`, `ImageLoader`, `warlockImageLoader`, `srcSet`, `sizes`, `priority`, `generateImageVariants`, `uploads.images`, `uploadedFileController`; "add an image to a page", "responsive images", "lazy load images", "LCP image", "image layout shift", "webp avif", "image CDN loader", "resize uploaded images". Skip: measuring LCP/CLS in the field — the `measure-web-vitals` topic; static files that need no resizing (`public/` URLs in a plain `<img>`) — the `create-a-page` topic; storage and upload handling — the `warlock-js-core` skill; competing components `next/image`, `react-image`, `unpic`.'
---

# Warlock — render images

`<Image>` turns a plain JSON description of an image and its renditions into a responsive `<img>` (or `<picture>`). It is a pure render with no effects and no state, so the server and the browser produce identical markup and hydration always matches. It never runs Sharp or reads a file; every URL either comes straight from the descriptor or from a small `loader` function.

```tsx title="src/web/blog/post.page.tsx"
import { Image, type ImageDescriptor, type PageConfig } from "@warlock.js/web";

const cover: ImageDescriptor = {
  src: "/uploads/posts/cover.jpg",
  width: 2400,
  height: 1350,
  variants: {
    card: { width: 640 },
    hero: { width: 1280 },
  },
  formats: ["webp"],
};

export const config = { route: { path: "/blog/post", name: "blog.post" } } satisfies PageConfig;

export default function PostPage() {
  return (
    <main>
      <Image
        image={cover}
        alt="A lighthouse at dusk"
        sizes="(min-width: 768px) 50vw, 100vw"
        priority
        className="cover"
      />
    </main>
  );
}
```

`Image`, `warlockImageLoader` and the types `ImageDescriptor`, `ImageVariantDescriptor`, `ImageFormat`, `ImageLoader`, `ImageLoaderInput` and `ImageProps` are all exported from `@warlock.js/web`.

## Props

| Prop | Type | Meaning |
| --- | --- | --- |
| `image` | `ImageDescriptor` | Required. The image and its renditions (below). |
| `alt` | `string` | Required. Pass `""` for a decorative image. In development a call that omits it logs `<Image> is missing "alt" for "<src>"` to the console. |
| `sizes` | `string` | The `sizes` attribute. Defaults to `"100vw"`; set it whenever the image is narrower than the viewport, or the browser picks an oversized file. |
| `priority` | `boolean` | `true` sets `loading="eager"` and `fetchPriority="high"`. Default is lazy. Use on the page's single LCP image only. |
| `loader` | `ImageLoader` | Turns a variant into a URL. Defaults to `warlockImageLoader`. |
| any `<img>` attribute | | `className`, `style`, `onLoad`, `id`, `data-*`, ... are passed to the `<img>`. `src`, `srcSet`, `width`, `height`, `loading`, `fetchPriority` and `sizes` are not accepted as props; they come from the descriptor and the props above. |

## The descriptor

```ts
type ImageDescriptor = {
  src: string; // the original path, e.g. "/uploads/posts/cover.jpg"
  width: number; // intrinsic width of the original, in pixels
  height: number; // intrinsic height of the original, in pixels
  variants: Readonly<Record<string, ImageVariantDescriptor>>; // keyed by variant NAME
  formats?: readonly ("avif" | "webp")[]; // extra formats to offer, in order
};

type ImageVariantDescriptor = {
  width: number; // rendered width of this variant
  height?: number;
  url?: string; // pre-generated URL for the default format (skips the loader)
  urls?: Partial<Record<"avif" | "webp", string>>; // pre-generated URL per extra format
};
```

It is plain, serializable data, so it can live on a database record and travel through page loader data to the browser.

## What it renders

- An `<img>` with `src` set to the **widest** variant, `srcSet` listing every variant as `<url> <width>w` sorted by width, the `sizes` attribute, `decoding="async"` and `loading="lazy"` (or eager with `priority`).
- `width` and `height` attributes taken from the descriptor's **original** `width` and `height`. They let the browser reserve the image's aspect ratio before it decodes, which is the biggest layout-shift win available. Add `max-width: 100%; height: auto` in CSS so a large intrinsic size does not overflow its column.
- With `formats`, a `<picture>`: one `<source type="image/webp">` (and so on, in the order given) with its own `srcSet` and `sizes`, then the `<img>` as the fallback. `className` and the other attributes land on the `<img>`, not the `<picture>`.
- With an empty `variants` object, `src` is `image.src` and there is no `srcSet`.

## URLs: the default loader and `uploads.images`

`warlockImageLoader` appends the variant name to the descriptor's `src`:

```text
/uploads/posts/cover.jpg?variant=card
/uploads/posts/cover.jpg?variant=card&format=webp
```

Core serves those URLs for **local** uploads. Three pieces:

1. Mount the controller once (the generated app already does this in `src/app/uploads/routes.ts`):

   ```ts
   import { router, uploadedFileController } from "@warlock.js/core";

   router.get("/uploads/*", uploadedFileController);
   ```

2. Declare the allowed variants in `src/config/uploads.ts`. Only names declared here can be requested, so a visitor cannot make the server compute an arbitrary size:

   ```ts title="src/config/uploads.ts"
   export default {
     images: {
       variants: {
         card: { width: 640 },
         hero: { width: 1280, height: 720, fit: "cover", quality: 80 },
       },
       formats: ["webp"], // allowed `&format=` values: "avif" | "webp"
     },
   };
   ```

   A variant takes `width` (required), `height`, `fit` (`"cover"` | `"contain"` | `"inside"`), `quality` (1 to 100) and `enlarge` (off by default, so a small source is never upscaled). `maxSourceBytes` (default 25 MB) and `maxSourcePixels` (default 40,000,000) cap the source. Without `uploads.images`, every `?variant=` request is refused with 400 and originals are still served.

3. Build the descriptor. Variants render on first request and are cached on disk; call `generateImageVariants(relativePath, { variants? })` right after saving an upload to render them once, up front, and get back a ready-made descriptor (plain JSON; store it next to the record):

   ```ts
   import { generateImageVariants } from "@warlock.js/core";

   // relativePath: the saved upload's path relative to the storage root
   const cover = await generateImageVariants("posts/cover.jpg");
   // { src: "/uploads/posts/cover.jpg", width, height, variants: { card: { width, height, url, urls? }, ... }, formats? }
   ```

   Its result is structurally an `ImageDescriptor`, so pass it straight to `<Image image={cover}>`. It needs a local storage driver with a root, and throws `ImageVariantsConfigError` if `uploads.images` is missing, `HttpError` 400 for an unknown variant name, 404 for a path outside the storage root, 413 for an oversized source and 415 for a source that is not jpeg, png, webp or avif.

## A CDN or object storage

Do not proxy remote files through `uploadedFileController`. Either store descriptors whose variants carry their own `url` / `urls` (the loader is then not called for them), or give `<Image>` a custom loader:

```tsx
import { Image, type ImageLoader } from "@warlock.js/web";

const cdnLoader: ImageLoader = ({ src, variant, format }) =>
  `https://cdn.example.com${src}/${variant}${format ? `.${format}` : ""}`;

export function Cover({ image, title }: { image: ImageDescriptor; title: string }) {
  return <Image image={image} alt={title} loader={cdnLoader} />;
}
```

A loader receives `{ src, variant, width, format? }` and returns a string. It must be a pure function so the server and the browser build the same URL.

## Gotchas

- **`alt` is required.** Use `alt=""` for decoration, never omit it.
- **`priority` is for one image per page.** It competes for bandwidth with the real LCP candidate if you set it on several. Everything else stays lazy. See the `measure-web-vitals` topic.
- **Own `sizes`.** The `"100vw"` default is right only for a full-width image.
- **Variant names must exist in `uploads.images.variants`** when you use the default loader and local uploads, or the variant URL answers 400.
- **gif and svg sources are not resized** (core answers 415 for a variant of one). Use a plain `<img>` pointing at the file in `public/` or its upload URL.
- **The `width`/`height` attributes are the original's.** Style the image with CSS (`max-width: 100%; height: auto`); do not rely on the attributes to size it.

## See also

- The `measure-web-vitals` topic: why `width`/`height` and `priority` matter for CLS and LCP.
- The `serve-styles` topic: styling the `<img>` with imported CSS.
- The `warlock-js-core` skill: `uploads` configuration, storage and the uploads route.
