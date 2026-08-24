import { describe, expect, it } from "vitest";
import { composeRoutePath } from "./compose-route-path";

describe("composeRoutePath", () => {
  it("takes the route path alone when the layout prefix is the root", () => {
    expect(composeRoutePath("/", "/account/settings")).toBe("/account/settings");
  });

  it("takes the layout prefix alone when the route path is the root", () => {
    expect(composeRoutePath("/products", "/")).toBe("/products");
  });

  it("resolves to the root when both the prefix and the route path are the root", () => {
    expect(composeRoutePath("/", "/")).toBe("/");
  });

  it("joins an ordinary prefix and an ordinary route path with no extra separator", () => {
    expect(composeRoutePath("/admin", "/settings")).toBe("/admin/settings");
  });

  it("strips a trailing slash off the prefix before joining", () => {
    expect(composeRoutePath("/products/", "/")).toBe("/products");
  });
});
