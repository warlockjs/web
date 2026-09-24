import { describe, expect, it } from "vitest";
import {
  DEFAULT_SITEMAP_CACHE_CONTROL,
  resolveSitemapHttpValidators,
} from "./sitemap-http-validators";

const sha256 = "a".repeat(64);
const generatedAt = "2026-09-24T10:15:29.987Z";

describe("resolveSitemapHttpValidators", () => {
  it("emits a quoted strong ETag, second-granularity Last-Modified, and default cache policy", () => {
    expect(resolveSitemapHttpValidators({ sha256, generatedAt })).toEqual({
      etag: `"${sha256}"`,
      lastModified: "Thu, 24 Sep 2026 10:15:29 GMT",
      cacheControl: DEFAULT_SITEMAP_CACHE_CONTROL,
      notModified: false,
    });
  });

  it("uses weak If-None-Match comparison for comma lists and wildcard", () => {
    expect(
      resolveSitemapHttpValidators({
        sha256,
        generatedAt,
        ifNoneMatch:
          '"other", W/"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
      }).notModified,
    ).toBe(true);
    expect(
      resolveSitemapHttpValidators({ sha256, generatedAt, ifNoneMatch: "*" }).notModified,
    ).toBe(true);
  });

  it("gives If-None-Match precedence over If-Modified-Since", () => {
    expect(
      resolveSitemapHttpValidators({
        sha256,
        generatedAt,
        ifNoneMatch: '"different"',
        ifModifiedSince: "Thu, 25 Sep 2026 10:15:29 GMT",
      }).notModified,
    ).toBe(false);
  });

  it("uses a valid If-Modified-Since only when no If-None-Match exists", () => {
    expect(
      resolveSitemapHttpValidators({
        sha256,
        generatedAt,
        ifModifiedSince: "Thu, 24 Sep 2026 10:15:29 GMT",
        method: "HEAD",
      }).notModified,
    ).toBe(true);
    expect(
      resolveSitemapHttpValidators({ sha256, generatedAt, ifModifiedSince: "not a date" })
        .notModified,
    ).toBe(false);
  });

  it("does not report GET/HEAD 304 semantics for another method", () => {
    expect(
      resolveSitemapHttpValidators({ sha256, generatedAt, ifNoneMatch: "*", method: "POST" })
        .notModified,
    ).toBe(false);
  });
});
