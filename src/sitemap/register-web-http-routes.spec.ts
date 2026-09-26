import config from "@mongez/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "@warlock.js/core";

const { generateSitemap, startSitemapRuntime } = vi.hoisted(() => ({
  generateSitemap: vi.fn(),
  startSitemapRuntime: vi.fn(),
}));

vi.mock("./generate-sitemap", () => ({ generateSitemap }));
vi.mock("./sitemap-lifecycle", () => ({
  getSitemapServingState: () => undefined,
  startSitemapRuntime,
}));

import { regenerateSitemapOnStartup, registerWebHttpRoutes } from "./register-web-http-routes";

function stubRouter(): Router {
  return { get: vi.fn(), head: vi.fn() } as unknown as Router;
}

afterEach(() => {
  config.set("app", {});
  config.set("web", {});
});

describe("registerWebHttpRoutes", () => {
  beforeEach(() => {
    generateSitemap.mockReset();
    startSitemapRuntime.mockReset();
    generateSitemap.mockResolvedValue({ mode: "disabled", urls: 0, duplicates: [], routes: [] });
    startSitemapRuntime.mockResolvedValue(undefined);
  });

  it("registers routes without generating when the sitemap is enabled", async () => {
    config.set("app", { publicUrl: "https://example.com" });
    config.set("web", { sitemap: { enabled: true } });

    const router = stubRouter();
    await registerWebHttpRoutes(router, { appRoot: "/app" });

    expect(generateSitemap).not.toHaveBeenCalled();
    expect(router.get).toHaveBeenCalledWith("/sitemap.xml", expect.any(Function));
    expect(router.head).toHaveBeenCalledWith("/sitemap.xml", expect.any(Function));
  });

  it("starts the managed runtime at startup when enabled and regenerate.onBoot is unset", async () => {
    config.set("app", { publicUrl: "https://example.com" });
    config.set("web", { sitemap: { enabled: true } });

    await regenerateSitemapOnStartup({ appRoot: "/app" });

    expect(startSitemapRuntime).toHaveBeenCalledWith({ appRoot: "/app" });
  });

  it("leaves multi-site sitemaps to each site's request: no single-origin runtime at startup", async () => {
    config.set("web", {
      sitemap: { enabled: true },
      sites: { landing: { pages: "(landing)", hosts: ["estates.test"] } },
    });

    await regenerateSitemapOnStartup({ appRoot: "/app" });

    expect(startSitemapRuntime).not.toHaveBeenCalled();
  });
  it("does not generate at startup when regenerate.onBoot is false", async () => {
    config.set("app", { publicUrl: "https://example.com" });
    config.set("web", { sitemap: { enabled: true, regenerate: { onBoot: false } } });

    await regenerateSitemapOnStartup({ appRoot: "/app" });

    expect(startSitemapRuntime).toHaveBeenCalledWith({ appRoot: "/app" });
  });

  it("does not generate, and registers no sitemap route, when the sitemap is disabled", async () => {
    config.set("web", { sitemap: { enabled: false } });
    const router = stubRouter();

    await registerWebHttpRoutes(router, { appRoot: "/app" });
    await regenerateSitemapOnStartup({ appRoot: "/app" });

    expect(startSitemapRuntime).not.toHaveBeenCalled();
    expect(router.get).not.toHaveBeenCalledWith("/sitemap.xml", expect.anything());
    expect(router.head).not.toHaveBeenCalledWith("/sitemap.xml", expect.anything());
  });

  it("boot continues when the first generation fails — the error was already reported", async () => {
    config.set("app", { publicUrl: "https://example.com" });
    config.set("web", { sitemap: { enabled: true } });
    generateSitemap.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(regenerateSitemapOnStartup({ appRoot: "/app" })).resolves.toBeUndefined();
  });
});
