import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createUnregisteredPageReporter,
  describeUnregisteredPages,
  findUnregisteredPageFiles,
} from "./unregistered-pages";

const appRoot = path.resolve("/app");
const appSrcRoot = path.join(appRoot, "src");
const webRoot = path.join(appSrcRoot, "web");
const homePage = path.join(webRoot, "home.page.tsx");
const aboutPage = path.join(webRoot, "about.page.tsx");
const notFoundPage = path.join(webRoot, "404.page.tsx");

function discoveredPage(pageFile: string, routePath: string) {
  return { pageFile, routePath, webRoot };
}

describe("findUnregisteredPageFiles", () => {
  it("compares global pages on disk with the installed page owners", () => {
    expect(
      findUnregisteredPageFiles({
        appRoot,
        appSrcRoot,
        registeredPageFiles: () => [homePage],
        discover: () => [discoveredPage(homePage, "/"), discoveredPage(aboutPage, "/about")],
      }),
    ).toEqual([aboutPage]);
  });

  it("excludes the reserved 404 page", () => {
    expect(
      findUnregisteredPageFiles({
        appRoot,
        appSrcRoot,
        registeredPageFiles: () => [homePage],
        discover: () => [
          discoveredPage(homePage, "/"),
          discoveredPage(notFoundPage, "*"),
        ],
      }),
    ).toEqual([]);
  });

  it("does not report a page below src/app", () => {
    const temporaryAppRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-unregistered-pages-"));
    const temporaryAppSrcRoot = path.join(temporaryAppRoot, "src");
    const modulePage = path.join(temporaryAppSrcRoot, "app", "main", "web", "ignored.page.tsx");

    try {
      fs.mkdirSync(path.dirname(modulePage), { recursive: true });
      fs.writeFileSync(modulePage, 'export const route = "/ignored";\nexport default () => null;');

      expect(
        findUnregisteredPageFiles({
          appRoot: temporaryAppRoot,
          appSrcRoot: temporaryAppSrcRoot,
          registeredPageFiles: () => [],
        }),
      ).toEqual([]);
    } finally {
      fs.rmSync(temporaryAppRoot, { recursive: true, force: true });
    }
  });

  it("discovers a matching page below a custom source root", () => {
    const temporaryAppRoot = fs.mkdtempSync(path.join(os.tmpdir(), "warlock-unregistered-pages-"));
    const temporaryAppSrcRoot = path.join(temporaryAppRoot, "source");
    const customPage = path.join(temporaryAppSrcRoot, "web", "about.page.tsx");
    const warn = vi.fn();

    try {
      fs.mkdirSync(path.dirname(customPage), { recursive: true });
      fs.writeFileSync(customPage, 'export const route = "/about";\nexport default () => null;');

      const report = createUnregisteredPageReporter({
        appRoot: temporaryAppRoot,
        appSrcRoot: temporaryAppSrcRoot,
        registeredPageFiles: () => [],
        warn,
      });

      report({ method: "GET", url: "/missing", pathname: "/missing" });
      expect(warn).not.toHaveBeenCalled();

      report({ method: "GET", url: "/about", pathname: "/about" });

      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain("source/web/about.page.tsx");
    } finally {
      fs.rmSync(temporaryAppRoot, { recursive: true, force: true });
    }
  });
});

describe("createUnregisteredPageReporter", () => {
  it("ignores a genuine 404, then names the matching unregistered page once", () => {
    const warn = vi.fn();
    const report = createUnregisteredPageReporter({
      appRoot,
      appSrcRoot,
      registeredPageFiles: () => [],
      discover: () => [discoveredPage(aboutPage, "/about")],
      warn,
    });

    report({ method: "GET", url: "/missing", pathname: "/missing" });
    expect(warn).not.toHaveBeenCalled();

    report({ method: "GET", url: "/about", pathname: "/about" });
    report({ method: "GET", url: "/about", pathname: "/about" });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("src/web/about.page.tsx");
  });

  it("stays silent after live registration owns the page", () => {
    const warn = vi.fn();
    let registered: string[] = [];
    const report = createUnregisteredPageReporter({
      appRoot,
      appSrcRoot,
      registeredPageFiles: () => registered,
      discover: () => [discoveredPage(aboutPage, "/about")],
      warn,
    });

    registered = [aboutPage];
    report({ method: "GET", url: "/about", pathname: "/about" });

    expect(warn).not.toHaveBeenCalled();
  });

  it("matches a dynamic effective route path", () => {
    const warn = vi.fn();
    const report = createUnregisteredPageReporter({
      appRoot,
      appSrcRoot,
      registeredPageFiles: () => [],
      discover: () => [discoveredPage(aboutPage, "/articles/:slug")],
      warn,
    });

    report({ method: "GET", url: "/articles/warlock", pathname: "/articles/warlock" });

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("src/web/about.page.tsx");
  });

  it("leaves the response diagnostic silent when discovery rejects a malformed page", () => {
    const warn = vi.fn();
    const report = createUnregisteredPageReporter({
      appRoot,
      appSrcRoot,
      registeredPageFiles: () => [],
      discover: () => {
        throw new Error("malformed page");
      },
      warn,
    });

    expect(() => report({ method: "GET", url: "/about", pathname: "/about" })).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("describeUnregisteredPages", () => {
  it("names the exact file without restart guidance", () => {
    const message = describeUnregisteredPages([aboutPage], appRoot, {
      method: "GET",
      url: "/about",
    });

    expect(message).toContain("src/web/about.page.tsx");
    expect(message).not.toMatch(/restart|press "r"/i);
  });
});
