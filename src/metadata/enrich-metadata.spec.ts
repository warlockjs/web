import { describe, expect, it } from "vitest";
import { enrichMetadata } from "./enrich-metadata";

const PUBLIC_URL = "https://app.test";

describe("enrichMetadata", () => {
  it("derives the canonical and og:url from the public URL and the request path", () => {
    const result = enrichMetadata(
      { title: "x" },
      { publicUrl: PUBLIC_URL, requestPath: "/ar/about?utm=1#top" },
    );

    expect(result?.canonical).toBe("https://app.test/ar/about");
    expect(result?.openGraph?.url).toBe("https://app.test/ar/about");
  });

  it("keeps an explicit canonical, and derives og:url from it", () => {
    const result = enrichMetadata(
      { canonical: "/canonical" },
      { publicUrl: PUBLIC_URL, requestPath: "/other" },
    );

    expect(result?.canonical).toBe("https://app.test/canonical");
    expect(result?.openGraph?.url).toBe("https://app.test/canonical");
  });

  it("an explicit openGraph.url wins over the canonical", () => {
    const result = enrichMetadata(
      { openGraph: { url: "https://x.test/u" } },
      { publicUrl: PUBLIC_URL, requestPath: "/p" },
    );

    expect(result?.openGraph?.url).toBe("https://x.test/u");
  });

  it("canonical: false removes the canonical and derives no og:url", () => {
    const result = enrichMetadata(
      { canonical: false },
      { publicUrl: PUBLIC_URL, requestPath: "/p" },
    );

    expect(result?.canonical).toBeUndefined();
    expect(result?.openGraph?.url).toBeUndefined();
  });

  it("absolutizes relative image urls and leaves absolute ones alone", () => {
    const result = enrichMetadata(
      {
        image: "/top.png",
        openGraph: {
          image: "/og.png",
          images: [{ url: "/a.png", width: 1 }, { url: "https://cdn.test/b.png" }],
        },
        twitter: { image: "/tw.png" },
      },
      { publicUrl: PUBLIC_URL, requestPath: "/" },
    );

    expect(result?.image).toBe("https://app.test/top.png");
    expect(result?.openGraph?.image).toBe("https://app.test/og.png");
    expect(result?.openGraph?.images).toEqual([
      { url: "https://app.test/a.png", width: 1 },
      { url: "https://cdn.test/b.png" },
    ]);
    expect(result?.twitter?.image).toBe("https://app.test/tw.png");
  });

  it("without a public URL nothing is derived or absolutized", () => {
    const metadata = { title: "x", image: "/i.png", openGraph: { url: "/u" } };

    expect(enrichMetadata(metadata, { requestPath: "/p" })).toEqual(metadata);
  });

  it("formats og:locale with an underscore and lists the other locales as alternates", () => {
    const result = enrichMetadata(
      { title: "x" },
      {
        publicUrl: PUBLIC_URL,
        requestPath: "/",
        locale: "en-US",
        alternateLocales: ["en-US", "ar", "fr-CA", "x-default"],
      },
    );

    expect(result?.openGraph?.locale).toBe("en_US");
    expect(result?.openGraph?.alternateLocales).toEqual(["ar", "fr_CA"]);
  });

  it("an explicit openGraph.locale wins", () => {
    const result = enrichMetadata(
      { openGraph: { locale: "de_DE" } },
      { requestPath: "/", locale: "en" },
    );

    expect(result?.openGraph?.locale).toBe("de_DE");
  });

  it("leaves a noindex page (error / not-found) without a canonical or og tags", () => {
    const metadata = { title: "Not found", robots: "noindex" };
    const result = enrichMetadata(metadata, {
      publicUrl: PUBLIC_URL,
      requestPath: "/nope",
      locale: "en",
    });

    expect(result).toEqual(metadata);
  });

  it("leaves undefined metadata undefined", () => {
    expect(enrichMetadata(undefined, { publicUrl: PUBLIC_URL, requestPath: "/" })).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const metadata = Object.freeze({ title: "x", openGraph: Object.freeze({ image: "/i.png" }) });

    expect(() =>
      enrichMetadata(metadata, { publicUrl: PUBLIC_URL, requestPath: "/" }),
    ).not.toThrow();
  });
});
