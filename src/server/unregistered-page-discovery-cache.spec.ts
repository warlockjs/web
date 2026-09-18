import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createUnregisteredPageReporter } from "./unregistered-pages";

const appRoot = path.resolve("/app");
const appSrcRoot = path.join(appRoot, "src");
const webRoot = path.join(appSrcRoot, "web");
const aboutPage = path.join(webRoot, "about.page.tsx");

function discoveredPage(pageFile: string, routePath: string) {
  return {
    type: "page" as const,
    routeName: path.basename(pageFile, ".page.tsx"),
    routePath,
    pageFile,
    webRoot,
    layouts: [],
    middlewareLayouts: [],
  };
}

/**
 * Proves the dev 404 diagnostic bounds its filesystem walk: arbitrary
 * unmatched traffic (bots, favicon, typos) must not re-run page discovery on
 * every request. Each `it` below drives `createUnregisteredPageReporter`
 * exactly the way `web-connector.ts`'s `onResponse` hook does.
 */
describe("createUnregisteredPageReporter discovery caching", () => {
  it("re-walks the filesystem at most once for repeated unmatched requests", () => {
    const discover = vi.fn(() => [discoveredPage(aboutPage, "/about")]);
    const report = createUnregisteredPageReporter({
      appRoot,
      appSrcRoot,
      registeredPageFiles: () => [],
      discover,
      warn: vi.fn(),
    });

    for (let i = 0; i < 5; i++) {
      report({ method: "GET", url: "/missing", pathname: "/missing" });
    }

    expect(discover).toHaveBeenCalledTimes(1);
  });

  it("joins concurrent unmatched requests into one walk, not one per request", () => {
    const discover = vi.fn(() => [discoveredPage(aboutPage, "/about")]);
    const report = createUnregisteredPageReporter({
      appRoot,
      appSrcRoot,
      registeredPageFiles: () => [],
      discover,
      warn: vi.fn(),
    });

    // Simulates concurrent misses landing before the first has a chance to
    // populate any cache: bots, favicon and a typo'd URL arriving together.
    const pathnames = ["/missing-1", "/missing-2", "/missing-3"];
    pathnames.forEach((pathname) => report({ method: "GET", url: pathname, pathname }));

    expect(discover).toHaveBeenCalledTimes(1);
  });

  it("re-walks after the watcher invalidates the snapshot, and sees the new route", () => {
    const warn = vi.fn();
    let pages = [discoveredPage(aboutPage, "/about")];
    const discover = vi.fn(() => pages);
    const report = createUnregisteredPageReporter({
      appRoot,
      appSrcRoot,
      registeredPageFiles: () => [],
      discover,
      warn,
    });

    report({ method: "GET", url: "/about", pathname: "/about" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(discover).toHaveBeenCalledTimes(1);

    const contactPage = path.join(webRoot, "contact.page.tsx");
    pages = [discoveredPage(aboutPage, "/about"), discoveredPage(contactPage, "/contact")];

    // Before the watcher fires, the stale snapshot still hides the new page.
    report({ method: "GET", url: "/contact", pathname: "/contact" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(discover).toHaveBeenCalledTimes(1);

    report.invalidateDiscovery();

    report({ method: "GET", url: "/contact", pathname: "/contact" });
    expect(discover).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toContain("contact.page.tsx");
  });
});
