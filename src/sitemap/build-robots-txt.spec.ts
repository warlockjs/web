import { describe, expect, it } from "vitest";
import type { LocaleRouting } from "../routing/locale-routing";
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

/**
 * Under an active locale-routing strategy, every `/`-rooted rule (other than
 * bare `/`) also emits its prefixed variant for each prefixed locale code —
 * otherwise `Disallow: /admin` leaves `/ar/admin` crawlable. The blog-proof
 * defect.
 */
describe("buildRobotsTxt — locale-prefixed rules", () => {
  const prefixExceptDefault: LocaleRouting = {
    strategy: "prefix-except-default",
    codes: ["en", "ar"],
    defaultLocale: "en",
  };

  it("emits the prefixed variant next to the original under prefix-except-default", () => {
    const output = buildRobotsTxt(
      { enabled: true, groups: [{ userAgent: "*", disallow: ["/admin"] }] },
      undefined,
      prefixExceptDefault,
    );

    expect(output).toBe(
      ["User-agent: *", "Disallow: /admin", "Disallow: /ar/admin", ""].join("\n"),
    );
  });

  it("expands both allow and disallow rules", () => {
    const output = buildRobotsTxt(
      {
        enabled: true,
        groups: [{ userAgent: "*", allow: ["/admin/login"], disallow: ["/admin"] }],
      },
      undefined,
      prefixExceptDefault,
    );

    expect(output).toBe(
      [
        "User-agent: *",
        "Allow: /admin/login",
        "Allow: /ar/admin/login",
        "Disallow: /admin",
        "Disallow: /ar/admin",
        "",
      ].join("\n"),
    );
  });

  it("expands a rule for every prefixed code under strategy prefix", () => {
    const output = buildRobotsTxt(
      { enabled: true, groups: [{ userAgent: "*", disallow: ["/admin"] }] },
      undefined,
      { strategy: "prefix", codes: ["en", "ar"], defaultLocale: "en" },
    );

    expect(output).toBe(
      ["User-agent: *", "Disallow: /admin", "Disallow: /en/admin", "Disallow: /ar/admin", ""].join(
        "\n",
      ),
    );
  });

  it("leaves the bare root rule alone", () => {
    const output = buildRobotsTxt(
      { enabled: true, groups: [{ userAgent: "*", disallow: ["/"] }] },
      undefined,
      prefixExceptDefault,
    );

    expect(output).toBe(["User-agent: *", "Disallow: /", ""].join("\n"));
  });

  it("leaves a wildcard rule alone", () => {
    const output = buildRobotsTxt(
      { enabled: true, groups: [{ userAgent: "*", disallow: ["/admin/*"] }] },
      undefined,
      prefixExceptDefault,
    );

    expect(output).toBe(["User-agent: *", "Disallow: /admin/*", ""].join("\n"));
  });

  it("leaves an end-anchored rule alone", () => {
    const output = buildRobotsTxt(
      { enabled: true, groups: [{ userAgent: "*", disallow: ["/admin.php$"] }] },
      undefined,
      prefixExceptDefault,
    );

    expect(output).toBe(["User-agent: *", "Disallow: /admin.php$", ""].join("\n"));
  });

  it("does not expand rules when strategy is none, matching the pre-existing default", () => {
    const output = buildRobotsTxt(
      { enabled: true, groups: [{ userAgent: "*", disallow: ["/admin"] }] },
      undefined,
      { strategy: "none", codes: [], defaultLocale: "" },
    );

    expect(output).toBe(["User-agent: *", "Disallow: /admin", ""].join("\n"));
  });

  it("dedupes when a rule's own prefixed variant is already configured verbatim", () => {
    const output = buildRobotsTxt(
      { enabled: true, groups: [{ userAgent: "*", disallow: ["/admin/login", "/admin"] }] },
      undefined,
      { strategy: "prefix", codes: ["ar"], defaultLocale: "en" },
    );

    // "/admin" expands to "/ar/admin"; "/admin/login" expands to
    // "/ar/admin/login" — no overlap, so nothing is actually deduped here,
    // but re-running the SAME path twice must not double the line.
    const repeated = buildRobotsTxt(
      { enabled: true, groups: [{ userAgent: "*", disallow: ["/admin", "/admin"] }] },
      undefined,
      { strategy: "prefix", codes: ["ar"], defaultLocale: "en" },
    );

    expect(output).toBe(
      [
        "User-agent: *",
        "Disallow: /admin/login",
        "Disallow: /ar/admin/login",
        "Disallow: /admin",
        "Disallow: /ar/admin",
        "",
      ].join("\n"),
    );
    expect(repeated).toBe(
      ["User-agent: *", "Disallow: /admin", "Disallow: /ar/admin", ""].join("\n"),
    );
  });
});
