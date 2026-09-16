/**
 * Crawler detection — the three configured shapes of
 * `web.streaming.crawlers`, tested against a real core `Request` so
 * `request.header()`'s lowercasing is exercised for real, not assumed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { setConfig } from "@warlock.js/core";
import { createCoreHttp } from "./__fixtures__/core-http";
import { DEFAULT_CRAWLER_USER_AGENTS, isCrawlerRequest } from "./detect-crawler";

afterEach(() => {
  setConfig("web", {});
});

function requestWithUserAgent(userAgent: string | undefined) {
  const { request } = createCoreHttp({
    url: "/",
    headers: userAgent === undefined ? {} : { "user-agent": userAgent },
  });
  return request;
}

describe("isCrawlerRequest — the default built-in list", () => {
  it("matches every documented default user agent, case-insensitively", () => {
    const documented = [
      "googlebot",
      "bingbot",
      "yandex",
      "duckduckbot",
      "baiduspider",
      "slurp",
      "applebot",
      "facebookexternalhit",
      "twitterbot",
      "linkedinbot",
      "discordbot",
      "slackbot",
      "telegrambot",
      "whatsapp",
      "embedly",
      "pinterest",
    ];

    expect(DEFAULT_CRAWLER_USER_AGENTS).toHaveLength(documented.length);

    for (const name of documented) {
      const upper = `Mozilla/5.0 (compatible; ${name.toUpperCase()}/2.1; +http://example.com/bot.html)`;
      expect(isCrawlerRequest(requestWithUserAgent(upper))).toBe(true);
    }
  });

  it("does not match an ordinary browser user agent", () => {
    const chrome =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";
    expect(isCrawlerRequest(requestWithUserAgent(chrome))).toBe(false);
  });

  it("does not match a request with no user agent at all", () => {
    expect(isCrawlerRequest(requestWithUserAgent(undefined))).toBe(false);
  });
});

describe("isCrawlerRequest — web.streaming.crawlers: false", () => {
  it("disables detection outright, even for a default-list user agent", () => {
    setConfig("web", { streaming: { crawlers: false } });

    expect(isCrawlerRequest(requestWithUserAgent("Googlebot/2.1"))).toBe(false);
  });
});

describe("isCrawlerRequest — web.streaming.crawlers.userAgents", () => {
  it("replaces the built-in list rather than extending it", () => {
    setConfig("web", { streaming: { crawlers: { userAgents: [/mycrawler/i] } } });

    expect(isCrawlerRequest(requestWithUserAgent("MyCrawler/1.0"))).toBe(true);
    expect(isCrawlerRequest(requestWithUserAgent("Googlebot/2.1"))).toBe(false);
  });
});

describe("isCrawlerRequest — web.streaming.crawlers.detect", () => {
  it("wins outright over the user-agent list, in both directions", () => {
    setConfig("web", { streaming: { crawlers: { detect: () => true } } });
    expect(isCrawlerRequest(requestWithUserAgent("a plain browser"))).toBe(true);

    setConfig("web", { streaming: { crawlers: { detect: () => false } } });
    expect(isCrawlerRequest(requestWithUserAgent("Googlebot/2.1"))).toBe(false);
  });

  it("receives the real request", () => {
    let seen: unknown;
    setConfig("web", {
      streaming: {
        crawlers: {
          detect: (request) => {
            seen = request;
            return false;
          },
        },
      },
    });

    const request = requestWithUserAgent("Googlebot/2.1");
    isCrawlerRequest(request);

    expect(seen).toBe(request);
  });
});
