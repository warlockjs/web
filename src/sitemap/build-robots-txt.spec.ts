import { describe, expect, it } from "vitest";
import { buildRobotsTxt } from "./build-robots-txt";

describe("buildRobotsTxt", () => {
  it("renders groups, extra lines and the Sitemap line in order", () => {
    const output = buildRobotsTxt(
      {
        enabled: true,
        groups: [{ userAgent: "*", disallow: ["/admin"], allow: ["/admin/login"] }],
        extra: ["Host: example.com"],
      },
      "https://example.com/sitemap.xml",
    );

    expect(output).toBe(
      [
        "User-agent: *",
        "Allow: /admin/login",
        "Disallow: /admin",
        "Host: example.com",
        "Sitemap: https://example.com/sitemap.xml",
        "",
      ].join("\n"),
    );
  });

  it("expands a multi-agent group into one User-agent line per agent", () => {
    const output = buildRobotsTxt(
      { enabled: true, groups: [{ userAgent: ["a", "b"] }] },
      undefined,
    );

    expect(output).toBe(["User-agent: a", "User-agent: b", ""].join("\n"));
  });

  it("omits the Sitemap line when there is no sitemap URL", () => {
    const output = buildRobotsTxt({ enabled: true, groups: [{ userAgent: "*" }] }, undefined);

    expect(output).not.toContain("Sitemap:");
  });

  it("omits the Sitemap line when referenceSitemap is false, even with a URL", () => {
    const output = buildRobotsTxt(
      { enabled: true, referenceSitemap: false, groups: [{ userAgent: "*" }] },
      "https://example.com/sitemap.xml",
    );

    expect(output).not.toContain("Sitemap:");
  });

  it("produces an empty string for no groups, no extra lines and no sitemap", () => {
    expect(buildRobotsTxt({ enabled: true }, undefined)).toBe("");
  });
});
