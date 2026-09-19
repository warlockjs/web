import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Image } from "./image";
import type { ImageDescriptor, ImageLoader, ImageProps } from "./types";

/**
 * Plain `node` environment (this project's default — no `@vitest-environment`
 * directive), deliberately: `react-dom/server`'s package export map resolves
 * to a DIFFERENT build under `jsdom` (the `"browser"` condition,
 * `server.browser.js`) than under real production SSR, which runs in Node
 * (the `"node"` condition, `server.node.js`) — proven by diffing their
 * `renderToString` output for this exact component: the browser build floats
 * an extra `<link rel="preload" as="image">` for a `fetchPriority="high"`
 * image that the Node build never emits. Asserting on markup CONTENT here,
 * under the same condition production actually resolves, is what makes these
 * assertions describe real behaviour instead of a jsdom-only artifact.
 * `image-hydration.spec.ts` is the file that legitimately needs `jsdom` (a
 * live DOM to hydrate into) and inherits that artifact as an accepted cost.
 */
const baseImage: ImageDescriptor = {
  src: "/uploads/posts/cover.jpg",
  width: 1600,
  height: 900,
  variants: {
    // Deliberately out of ascending order, to prove the component sorts.
    large: { width: 1200 },
    small: { width: 400 },
    medium: { width: 800 },
  },
};

describe("Image — srcSet and fallback src", () => {
  it("orders srcSet ascending by width regardless of variant key order", () => {
    const html = renderToString(createElement(Image, { image: baseImage, alt: "A mountain" }));

    const srcSetMatch = html.match(/srcSet="([^"]*)"/);
    expect(srcSetMatch?.[1]).toBe(
      "/uploads/posts/cover.jpg?variant=small 400w, " +
        "/uploads/posts/cover.jpg?variant=medium 800w, " +
        "/uploads/posts/cover.jpg?variant=large 1200w",
    );
  });

  it("breaks width ties by variant name", () => {
    const image: ImageDescriptor = {
      ...baseImage,
      variants: {
        z: { width: 400 },
        a: { width: 400 },
      },
    };

    const html = renderToString(createElement(Image, { image, alt: "tie" }));
    const srcSetMatch = html.match(/srcSet="([^"]*)"/);
    expect(srcSetMatch?.[1]).toBe(
      "/uploads/posts/cover.jpg?variant=a 400w, /uploads/posts/cover.jpg?variant=z 400w",
    );
  });

  it("uses the largest variant's URL as the fallback src", () => {
    const html = renderToString(createElement(Image, { image: baseImage, alt: "A mountain" }));

    expect(html).toContain('src="/uploads/posts/cover.jpg?variant=large"');
  });

  it("falls back to image.src with no srcSet when there are no variants", () => {
    const image: ImageDescriptor = {
      src: "/uploads/hero.jpg",
      width: 100,
      height: 50,
      variants: {},
    };

    const html = renderToString(createElement(Image, { image, alt: "hero" }));

    expect(html).toContain('src="/uploads/hero.jpg"');
    expect(html).not.toContain("srcSet=");
  });
});

describe("Image — pre-generated URLs win over the loader", () => {
  it("uses variant.url and never calls the loader for it", () => {
    const loader = vi.fn<ImageLoader>(() => "should-not-be-used");
    const image: ImageDescriptor = {
      src: "/uploads/cover.jpg",
      width: 100,
      height: 50,
      variants: { small: { width: 400, url: "https://cdn.example.com/small.jpg" } },
    };

    const html = renderToString(createElement(Image, { image, alt: "cdn", loader }));

    expect(html).toContain('src="https://cdn.example.com/small.jpg"');
    expect(loader).not.toHaveBeenCalled();
  });

  it("uses variant.urls[format] for source srcSet and never calls the loader for it", () => {
    const loader = vi.fn<ImageLoader>(() => "should-not-be-used");
    const image: ImageDescriptor = {
      src: "/uploads/cover.jpg",
      width: 100,
      height: 50,
      variants: {
        small: {
          width: 400,
          url: "https://cdn.example.com/small.jpg",
          urls: { webp: "https://cdn.example.com/small.webp" },
        },
      },
      formats: ["webp"],
    };

    const html = renderToString(createElement(Image, { image, alt: "cdn", loader }));

    expect(html).toContain('srcSet="https://cdn.example.com/small.webp 400w"');
    expect(loader).not.toHaveBeenCalled();
  });

  it("calls a custom loader for every non-pre-generated URL", () => {
    const loader = vi.fn<ImageLoader>(
      ({ src, variant, format }) =>
        `https://img.example.com/${variant}${format ? `.${format}` : ""}?u=${src}`,
    );
    const image: ImageDescriptor = {
      src: "/uploads/cover.jpg",
      width: 100,
      height: 50,
      variants: { small: { width: 400 }, large: { width: 800 } },
      formats: ["avif"],
    };

    renderToString(createElement(Image, { image, alt: "custom", loader }));

    expect(loader).toHaveBeenCalledWith({
      src: "/uploads/cover.jpg",
      variant: "small",
      width: 400,
    });
    expect(loader).toHaveBeenCalledWith({
      src: "/uploads/cover.jpg",
      variant: "large",
      width: 800,
    });
    expect(loader).toHaveBeenCalledWith({
      src: "/uploads/cover.jpg",
      variant: "small",
      width: 400,
      format: "avif",
    });
    expect(loader).toHaveBeenCalledWith({
      src: "/uploads/cover.jpg",
      variant: "large",
      width: 800,
      format: "avif",
    });
  });
});

describe("Image — <picture> and <source>", () => {
  it("renders no <picture> when formats is absent", () => {
    const html = renderToString(createElement(Image, { image: baseImage, alt: "no formats" }));

    expect(html).not.toContain("<picture");
    expect(html.startsWith("<img")).toBe(true);
  });

  it("renders a <source> per format, in order, with correct type/srcSet/sizes", () => {
    const image: ImageDescriptor = {
      ...baseImage,
      formats: ["avif", "webp"],
    };

    const html = renderToString(createElement(Image, { image, alt: "formats", sizes: "50vw" }));

    expect(html).toContain("<picture");
    const avifIndex = html.indexOf('type="image/avif"');
    const webpIndex = html.indexOf('type="image/webp"');
    const imgIndex = html.indexOf("<img");
    expect(avifIndex).toBeGreaterThan(-1);
    expect(webpIndex).toBeGreaterThan(avifIndex);
    expect(imgIndex).toBeGreaterThan(webpIndex);

    const sourceTags = html.match(/<source[^>]*>/g) ?? [];
    expect(sourceTags).toHaveLength(2);
    for (const tag of sourceTags) {
      expect(tag).toContain('sizes="50vw"');
      expect(tag).toMatch(/srcSet="[^"]+ 400w, [^"]+ 800w, [^"]+ 1200w"/);
    }
  });
});

describe("Image — attributes", () => {
  it("sets width/height and defaults to lazy loading with async decoding", () => {
    const html = renderToString(createElement(Image, { image: baseImage, alt: "lazy" }));

    expect(html).toContain('width="1600"');
    expect(html).toContain('height="900"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).not.toContain("fetchPriority");
  });

  it("sets loading=eager and a fetchPriority=high attribute when priority is true", () => {
    const html = renderToString(
      createElement(Image, { image: baseImage, alt: "priority", priority: true }),
    );

    // React 19's SSR float for a `fetchPriority="high"` image with a
    // `srcSet` emits a `<link rel="preload" as="image">` ahead of the
    // `<img>` itself — this happens under real Node SSR too, not only the
    // `jsdom`/browser build (proven by diffing `renderToString` output for
    // this exact component under each), so the markup does not start with
    // `<img`. Assert on the `<img>` tag's own attributes instead of on
    // string position, and separately confirm the img tag is present.
    const imgMatch = html.match(/<img[^>]*>/);
    expect(imgMatch).not.toBeNull();
    const imgTag = imgMatch?.[0] ?? "";
    expect(imgTag).toContain('loading="eager"');
    // `fetchPriority` is React's prop name (see `ImgHTMLAttributes`); under
    // this project's actual "node" module resolution, `renderToString`
    // serializes it verbatim as `fetchPriority="..."` — HTML attribute names
    // are case-insensitive, so this IS the `fetchpriority` attribute the
    // browser parses, just not lowercased in the wire string.
    expect(imgTag).toContain('fetchPriority="high"');
  });

  it("passes through remaining img attributes", () => {
    // `data-*` attributes are not part of `ImgHTMLAttributes`'s declared
    // props — real usage relies on JSX's special-cased allowance for them,
    // which `createElement` calls do not get. Cast at the call site rather
    // than widen `ImageProps` for a test-only attribute.
    const html = renderToString(
      createElement(Image, {
        image: baseImage,
        alt: "extra",
        className: "hero-image",
        id: "hero",
        "data-testid": "hero-image",
      } as ImageProps),
    );

    expect(html).toContain('class="hero-image"');
    expect(html).toContain('id="hero"');
    expect(html).toContain('data-testid="hero-image"');
  });
});
