import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Application, resetRolesCacheForTests } from "@warlock.js/core";
import { providePageManifest } from "./page-manifest";
import { WebConnector } from "./web-connector";
import { regenerateSitemapOnStartup } from "../sitemap/register-web-http-routes";

// Same scoping as `web-connector-unregistered-pages-cache.spec.ts`'s own
// production-boot describe block: mock everything a production `boot()` does
// besides the one question this file asks (does the role gate skip page
// installation?).
vi.mock("./install-production-page-routes", () => ({
  installProductionPageRoutes: vi.fn(async () => []),
}));
vi.mock("./register-production-public-files", () => ({
  registerProductionPublicFiles: vi.fn(),
}));
vi.mock("../sitemap/register-web-http-routes", () => ({
  registerWebHttpRoutes: vi.fn(async () => undefined),
  regenerateSitemapOnStartup: vi.fn(async () => undefined),
}));

import { installProductionPageRoutes } from "./install-production-page-routes";

// `providePageManifest` enforces a once-per-process contract (its own doc
// comment) and ships no resetter on purpose, so every test in this file reads
// back the SAME empty manifest, provided exactly once here.
providePageManifest({ pages: [] });

beforeEach(() => {
  resetRolesCacheForTests();
  vi.mocked(installProductionPageRoutes).mockClear();
  vi.mocked(regenerateSitemapOnStartup).mockClear();
});

afterEach(() => {
  delete process.env.WARLOCK_ROLES;
  delete process.env.WARLOCK_SITES;
  resetRolesCacheForTests();
  Application.setRuntimeStrategy("development");
  vi.restoreAllMocks();
});

describe("WebConnector.boot role gate", () => {
  it("installs no page routes for an api-only role and logs which roles are active", async () => {
    process.env.WARLOCK_ROLES = "api";
    Application.setRuntimeStrategy("production");

    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const connector = new WebConnector();

    await expect(connector.boot()).resolves.toBeUndefined();

    expect(installProductionPageRoutes).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("web: pages not installed (role: api)");
  });

  it("installs page routes for the web role", async () => {
    process.env.WARLOCK_ROLES = "web";
    Application.setRuntimeStrategy("production");

    const connector = new WebConnector();

    await expect(connector.boot()).resolves.toBeUndefined();

    expect(installProductionPageRoutes).toHaveBeenCalledOnce();
  });

  it("installs page routes when no role is set, unchanged from today", async () => {
    Application.setRuntimeStrategy("production");

    const connector = new WebConnector();

    await expect(connector.boot()).resolves.toBeUndefined();

    expect(installProductionPageRoutes).toHaveBeenCalledOnce();
  });

  it("skips sitemap regeneration in start() for an api-only role", async () => {
    process.env.WARLOCK_ROLES = "api";
    Application.setRuntimeStrategy("production");

    const connector = new WebConnector();
    await connector.boot();

    await connector.start();

    expect(regenerateSitemapOnStartup).not.toHaveBeenCalled();
  });
});
