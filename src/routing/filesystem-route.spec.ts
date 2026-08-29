import { describe, expect, it } from "vitest";
import { deriveFilesystemRouteName, deriveFilesystemRoutePath } from "./filesystem-route";

describe("filesystem route derivation", () => {
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
});
