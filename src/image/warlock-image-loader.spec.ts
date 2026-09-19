import { describe, expect, it } from "vitest";
import { warlockImageLoader } from "./warlock-image-loader";

describe("warlockImageLoader", () => {
  it("builds a variant query string with no format", () => {
    const url = warlockImageLoader({ src: "/uploads/cover.jpg", variant: "small", width: 400 });

    expect(url).toBe("/uploads/cover.jpg?variant=small");
  });

  it("appends the format when given", () => {
    const url = warlockImageLoader({
      src: "/uploads/cover.jpg",
      variant: "small",
      width: 400,
      format: "webp",
    });

    expect(url).toBe("/uploads/cover.jpg?variant=small&format=webp");
  });

  it("encodes the variant name", () => {
    const url = warlockImageLoader({
      src: "/uploads/cover.jpg",
      variant: "hero banner/wide",
      width: 400,
    });

    expect(url).toBe("/uploads/cover.jpg?variant=hero%20banner%2Fwide");
  });
});
