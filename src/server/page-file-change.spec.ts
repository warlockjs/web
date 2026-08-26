import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyPageFileChanges,
  hasPageFileChanges,
  isPageFilePath,
} from "./page-file-change";

const appRoot = path.resolve("/app");
const appSrcRoot = path.join(appRoot, "src");
const webRoot = path.join(appSrcRoot, "web");
const homePage = path.join(webRoot, "home.page.tsx");
const aboutPage = path.join(webRoot, "about.page.tsx");

const existing = (...files: string[]) => {
  const present = new Set(files);

  return (file: string) => present.has(file);
};

describe("classifyPageFileChanges", () => {
  it("classifies an uninstalled page on disk as added", () => {
    expect(
      classifyPageFileChanges([aboutPage], {
        appRoot,
        appSrcRoot,
        installedPageFiles: [homePage],
        fileExists: existing(homePage, aboutPage),
      }),
    ).toEqual({ added: [aboutPage], removed: [], inspectionNeeded: [] });
  });

  it("classifies an installed page missing from disk as removed", () => {
    expect(
      classifyPageFileChanges([aboutPage], {
        appRoot,
        appSrcRoot,
        installedPageFiles: [homePage, aboutPage],
        fileExists: existing(homePage),
      }),
    ).toEqual({ added: [], removed: [aboutPage], inspectionNeeded: [] });
  });

  it("retains an installed page on disk for identity inspection", () => {
    expect(
      classifyPageFileChanges([homePage], {
        appRoot,
        appSrcRoot,
        installedPageFiles: [homePage],
        fileExists: existing(homePage),
      }),
    ).toEqual({ added: [], removed: [], inspectionNeeded: [homePage] });
  });

  it("normalizes and deduplicates watcher paths", () => {
    const changes = classifyPageFileChanges(
      ["src/web/about.page.tsx", "src\\web\\about.page.tsx", aboutPage],
      {
        appRoot,
        appSrcRoot,
        installedPageFiles: [],
        fileExists: existing(aboutPage),
      },
    );

    expect(changes).toEqual({ added: [aboutPage], removed: [], inspectionNeeded: [] });
  });

  it("ignores non-page files", () => {
    const layout = path.join(webRoot, "layout.tsx");

    expect(
      classifyPageFileChanges([layout], {
        appRoot,
        appSrcRoot,
        installedPageFiles: [],
        fileExists: existing(layout),
      }),
    ).toEqual({ added: [], removed: [], inspectionNeeded: [] });
  });

  it("silently ignores page-like files under src/app", () => {
    const appPage = path.join(appSrcRoot, "app", "main", "web", "home.page.tsx");

    expect(
      classifyPageFileChanges([appPage], {
        appRoot,
        appSrcRoot,
        installedPageFiles: [appPage],
        fileExists: existing(appPage),
      }),
    ).toEqual({ added: [], removed: [], inspectionNeeded: [] });
  });

  it("returns an empty classification for an empty batch", () => {
    const changes = classifyPageFileChanges([], {
      appRoot,
      appSrcRoot,
      installedPageFiles: [homePage],
      fileExists: existing(homePage),
    });

    expect(changes).toEqual({ added: [], removed: [], inspectionNeeded: [] });
    expect(hasPageFileChanges(changes)).toBe(false);
  });

  it("reports work when any category is non-empty", () => {
    expect(
      hasPageFileChanges({ added: [], removed: [], inspectionNeeded: [homePage] }),
    ).toBe(true);
  });
});

describe("isPageFilePath", () => {
  it("only accepts .page.tsx files below src/web", () => {
    expect(isPageFilePath(homePage, appSrcRoot)).toBe(true);
    expect(isPageFilePath(path.join(webRoot, "nested", "about.page.tsx"), appSrcRoot)).toBe(
      true,
    );
    expect(
      isPageFilePath(path.join(appSrcRoot, "app", "main", "web", "home.page.tsx"), appSrcRoot),
    ).toBe(false);
    expect(isPageFilePath(path.join(webRoot, "home.tsx"), appSrcRoot)).toBe(false);
  });
});
