import config from "@mongez/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpContext, Router } from "@warlock.js/core";
import { registerRobotsRoute } from "./register-robots-route";

const temporaryDirectories: string[] = [];

function publicDir(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-robots-route-"));
  temporaryDirectories.push(dir);

  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf-8");
  }

  return dir;
}

function capturingRouter() {
  const routes = new Map<string, (context: HttpContext) => unknown>();
  const router = {
    get: vi.fn((routePath: string, handler: (context: HttpContext) => unknown) => {
      routes.set(routePath, handler);
    }),
  } as unknown as Router;

  return { router, routes };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }

  config.set("app", {});
  config.set("web", {});
});

describe("registerRobotsRoute", () => {
  it("registers no route when web.robots.enabled is unset", () => {
    config.set("web", {});
    const { router, routes } = capturingRouter();

    registerRobotsRoute(router, { publicDir: publicDir() });

    expect(routes.size).toBe(0);
  });

  it("registers /robots.txt and appends the Sitemap line when the sitemap is enabled", async () => {
    config.set("app", { publicUrl: "https://example.com" });
    config.set("web", {
      robots: { enabled: true, groups: [{ userAgent: "*", disallow: ["/admin"] }] },
      sitemap: { enabled: true, path: "/sitemap.xml" },
    });

    const { router, routes } = capturingRouter();
    registerRobotsRoute(router, { publicDir: publicDir() });

    const response = { text: vi.fn() };
    await routes.get("/robots.txt")!({ request: {} as never, response: response as never });

    expect(response.text).toHaveBeenCalledWith(
      "User-agent: *\nDisallow: /admin\nSitemap: https://example.com/sitemap.xml\n",
    );
  });

  it("registers /robots.txt with no Sitemap line when the sitemap is disabled", async () => {
    config.set("web", {
      robots: { enabled: true, groups: [{ userAgent: "*" }] },
      sitemap: { enabled: false },
    });

    const { router, routes } = capturingRouter();
    registerRobotsRoute(router, { publicDir: publicDir() });

    const response = { text: vi.fn() };
    await routes.get("/robots.txt")!({ request: {} as never, response: response as never });

    expect(response.text).toHaveBeenCalledWith("User-agent: *\n");
  });

  it("defers to an app-shipped public/robots.txt and registers no route", () => {
    config.set("web", { robots: { enabled: true, groups: [{ userAgent: "*" }] } });
    const warn = vi.fn();

    const { router, routes } = capturingRouter();
    registerRobotsRoute(router, {
      publicDir: publicDir({ "robots.txt": "User-agent: *\nDisallow: /\n" }),
      warn,
    });

    expect(routes.size).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("public/robots.txt");
  });
});
