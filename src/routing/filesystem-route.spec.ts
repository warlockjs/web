import { describe, expect, it } from "vitest";
import { PageFileSegmentNotSupportedError } from "./page-file-segment";
import { deriveFilesystemRouteName, deriveFilesystemRoutePath } from "./filesystem-route";

describe("filesystem route derivation — innocent cases", () => {
  it.each([
    ["hello-world.page.tsx", "/hello-world"],
    ["index.page.tsx", "/"],
    ["home.page.tsx", "/home"],
    ["welcome/index.page.tsx", "/welcome"],
    ["welcome/home.page.tsx", "/welcome/home"],
    ["(marketing)/pricing.page.tsx", "/pricing"],
    ["products/[id].page.tsx", "/products/:id"],
  ])("derives %s as %s", (pageFile, routePath) => {
    expect(deriveFilesystemRoutePath({ pageFile })).toBe(routePath);
  });

  it("lets a layout prefix replace its own directory segment", () => {
    expect(
      deriveFilesystemRoutePath({
        pageFile: "welcome/home.page.tsx",
        layoutPrefixes: { welcome: "/welcome" },
      }),
    ).toBe("/welcome/home");

    expect(
      deriveFilesystemRoutePath({
        pageFile: "admin/index.page.tsx",
        layoutPrefixes: { admin: "/dashboard" },
      }),
    ).toBe("/dashboard");
  });

  it("derives dotted names from filesystem identity and omits groups", () => {
    expect(deriveFilesystemRouteName("admin/products/details.page.tsx")).toBe(
      "admin.products.details",
    );
    expect(deriveFilesystemRouteName("(internal)/users/[id].page.tsx")).toBe("users.id");
    expect(deriveFilesystemRouteName("index.page.tsx")).toBe("index");
  });

  it("contributes nothing for a `(group)` directory in the path", () => {
    expect(deriveFilesystemRoutePath({ pageFile: "(marketing)/blog/[id].page.tsx" })).toBe(
      "/blog/:id",
    );
  });

  it("keeps a plain static segment as a literal path segment", () => {
    expect(deriveFilesystemRoutePath({ pageFile: "settings/billing.page.tsx" })).toBe(
      "/settings/billing",
    );
  });

  it("derives a deep, nested, valid page correctly", () => {
    expect(
      deriveFilesystemRoutePath({
        pageFile: "(shop)/products/[category]/[id]/reviews.page.tsx",
      }),
    ).toBe("/products/:category/:id/reviews");

    expect(deriveFilesystemRouteName("(shop)/products/[category]/[id]/reviews.page.tsx")).toBe(
      "products.category.id.reviews",
    );
  });

  it("still lets a valid layout prefix contribute its segments exactly as before", () => {
    expect(
      deriveFilesystemRoutePath({
        pageFile: "docs/getting-started.page.tsx",
        layoutPrefixes: { docs: "/docs" },
      }),
    ).toBe("/docs/getting-started");

    expect(
      deriveFilesystemRoutePath({
        pageFile: "home.page.tsx",
        layoutPrefixes: { "": "/app" },
      }),
    ).toBe("/app/home");
  });
});

describe("filesystem route derivation — rejected filesystem segments", () => {
  it("throws for a catch-all basename `docs/[...slug].page.tsx`", () => {
    expect(() => deriveFilesystemRoutePath({ pageFile: "docs/[...slug].page.tsx" })).toThrow(
      PageFileSegmentNotSupportedError,
    );

    try {
      deriveFilesystemRoutePath({ pageFile: "docs/[...slug].page.tsx" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PageFileSegmentNotSupportedError);
      const notSupported = error as PageFileSegmentNotSupportedError;
      expect(notSupported.message).toContain("docs/[...slug].page.tsx");
      expect(notSupported.message).toContain("[...slug]");
    }
  });

  it("throws for two bracket groups in a basename `posts/[id].[slug].page.tsx`", () => {
    expect(() => deriveFilesystemRoutePath({ pageFile: "posts/[id].[slug].page.tsx" })).toThrow(
      PageFileSegmentNotSupportedError,
    );

    try {
      deriveFilesystemRouteName("posts/[id].[slug].page.tsx");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PageFileSegmentNotSupportedError);
      const notSupported = error as PageFileSegmentNotSupportedError;
      expect(notSupported.message).toContain("posts/[id].[slug].page.tsx");
      expect(notSupported.message).toContain("[id].[slug]");
    }
  });

  it("throws for two bracket groups joined by other text `posts/[a]-[b].page.tsx`", () => {
    expect(() => deriveFilesystemRoutePath({ pageFile: "posts/[a]-[b].page.tsx" })).toThrow(
      PageFileSegmentNotSupportedError,
    );
  });

  it("throws for an empty parameter name `posts/[].page.tsx`", () => {
    expect(() => deriveFilesystemRoutePath({ pageFile: "posts/[].page.tsx" })).toThrow(
      PageFileSegmentNotSupportedError,
    );
  });

  it("throws for a parameter name starting with a digit `posts/[1bad].page.tsx`", () => {
    expect(() => deriveFilesystemRoutePath({ pageFile: "posts/[1bad].page.tsx" })).toThrow(
      PageFileSegmentNotSupportedError,
    );
  });

  it("throws for an unbalanced bracket in a directory segment `[id/details.page.tsx`", () => {
    expect(() => deriveFilesystemRoutePath({ pageFile: "[id/details.page.tsx" })).toThrow(
      PageFileSegmentNotSupportedError,
    );
  });

  it("throws from deriveFilesystemRouteName for the same rejected basename", () => {
    expect(() => deriveFilesystemRouteName("posts/[a]-[b].page.tsx")).toThrow(
      PageFileSegmentNotSupportedError,
    );
  });
});

describe("filesystem route derivation — layout prefix bypass", () => {
  it("throws for a catch-all layout prefix instead of silently passing it through", () => {
    expect(() =>
      deriveFilesystemRoutePath({
        pageFile: "docs/getting-started.page.tsx",
        layoutPrefixes: { docs: "/docs/[...slug]" },
      }),
    ).toThrow(PageFileSegmentNotSupportedError);

    try {
      deriveFilesystemRoutePath({
        pageFile: "docs/getting-started.page.tsx",
        layoutPrefixes: { docs: "/docs/[...slug]" },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PageFileSegmentNotSupportedError);
      const notSupported = error as PageFileSegmentNotSupportedError;
      expect(notSupported.message).toContain("docs/getting-started.page.tsx");
      expect(notSupported.message).toContain("layout prefix");
      expect(notSupported.message).toContain("/docs/[...slug]");
      expect(notSupported.message).toContain("[...slug]");
    }
  });

  it("throws for a layout prefix with two bracket groups in one segment", () => {
    expect(() =>
      deriveFilesystemRoutePath({
        pageFile: "x/page.page.tsx",
        layoutPrefixes: { x: "/x/[a]-[b]" },
      }),
    ).toThrow(PageFileSegmentNotSupportedError);

    try {
      deriveFilesystemRoutePath({
        pageFile: "x/page.page.tsx",
        layoutPrefixes: { x: "/x/[a]-[b]" },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PageFileSegmentNotSupportedError);
      const notSupported = error as PageFileSegmentNotSupportedError;
      expect(notSupported.message).toContain("x/page.page.tsx");
      expect(notSupported.message).toContain("layout prefix");
      expect(notSupported.message).toContain("/x/[a]-[b]");
    }
  });

  it("throws for a rejected root layout prefix (keyed by empty string)", () => {
    expect(() =>
      deriveFilesystemRoutePath({
        pageFile: "home.page.tsx",
        layoutPrefixes: { "": "/[...slug]" },
      }),
    ).toThrow(PageFileSegmentNotSupportedError);
  });
});
