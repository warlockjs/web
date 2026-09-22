import config from "@mongez/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Router } from "@warlock.js/core";

const { generateSitemap } = vi.hoisted(() => ({ generateSitemap: vi.fn() }));

vi.mock("./generate-sitemap", () => ({ generateSitemap }));

import { regenerateSitemapOnStartup, registerWebHttpRoutes } from "./register-web-http-routes";
import { resetSitemapLifecycleForTests } from "./sitemap-lifecycle";

function stubRouter(): Router {
  return { get: vi.fn() } as unknown as Router;
}

afterEach(() => {
  config.set("app", {});
  config.set("web", {});
});

describe("registerWebHttpRoutes", () => {
  beforeEach(() => {
    generateSitemap.mockReset();
    generateSitemap.mockResolvedValue({ mode: "disabled", urls: 0, duplicates: [], routes: [] });
    resetSitemapLifecycleForTests();
  });

  it("registers routes without generating when the sitemap is enabled", async () => {
    config.set("app", { publicUrl: "https://example.com" });
    config.set("web", { sitemap: { enabled: true } });

    await registerWebHttpRoutes(stubRouter(), { appRoot: "/app" });

    expect(generateSitemap).not.toHaveBeenCalled();
  });

  it("generates once at startup when enabled and regenerate.onBoot is unset", async () => {
    config.set("app", { publicUrl: "https://example.com" });
    config.set("web", { sitemap: { enabled: true } });

    await regenerateSitemapOnStartup({ appRoot: "/app" });

    expect(generateSitemap).toHaveBeenCalledTimes(1);
  });

  it("does not generate at startup when regenerate.onBoot is false", async () => {
    config.set("app", { publicUrl: "https://example.com" });
    config.set("web", { sitemap: { enabled: true, regenerate: { onBoot: false } } });

    await regenerateSitemapOnStartup({ appRoot: "/app" });

    expect(generateSitemap).not.toHaveBeenCalled();
  });

  it("does not generate, and registers no sitemap route, when the sitemap is disabled", async () => {
    config.set("web", { sitemap: { enabled: false } });
    const router = stubRouter();

    await registerWebHttpRoutes(router, { appRoot: "/app" });
    await regenerateSitemapOnStartup({ appRoot: "/app" });

    expect(generateSitemap).not.toHaveBeenCalled();
    expect(router.get).not.toHaveBeenCalledWith("/sitemap.xml", expect.anything());
  });

  it("boot continues when the first generation fails — the error was already reported", async () => {
    config.set("app", { publicUrl: "https://example.com" });
    config.set("web", { sitemap: { enabled: true } });
    generateSitemap.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(regenerateSitemapOnStartup({ appRoot: "/app" })).resolves.toBeUndefined();
  });
});
