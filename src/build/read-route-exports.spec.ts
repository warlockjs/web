import { describe, expect, it } from "vitest";
import { NonLiteralRouteExportError, readRouteExports } from "./read-route-exports";

/** The reader takes the source directly, so no fixture ever touches the disk here. */
function read(source: string, sourceFile = "src/app/shop/web/list.page.tsx") {
  return readRouteExports(sourceFile, source);
}

describe("readRouteExports — the literal forms it accepts", () => {
  it("reads a bare string route", () => {
    const result = read('export const route = "/list";');

    expect(result).toEqual({ ok: true, route: { path: "/list" } });
  });

  it("reads an object route with both keys", () => {
    const result = read('export const route = { path: "/list", name: "shop.list" };');

    expect(result).toEqual({ ok: true, route: { path: "/list", name: "shop.list" } });
  });

  it("reads an object route that omits `name` — the server derives it", () => {
    expect(read('export const route = { path: "/list" };')).toEqual({
      ok: true,
      route: { path: "/list" },
    });
  });

  it("reads a layout prefix", () => {
    expect(read('export const prefix = "/shop";', "src/app/shop/web/layout.tsx")).toEqual({
      ok: true,
      prefix: "/shop",
    });
  });

  it("unwraps `as const` and `satisfies` around either export", () => {
    expect(read('export const route = "/list" as const;')).toEqual({
      ok: true,
      route: { path: "/list" },
    });
    expect(read('export const route = { path: "/list" } as const;')).toEqual({
      ok: true,
      route: { path: "/list" },
    });
    expect(read('export const route = "/list" satisfies string;')).toEqual({
      ok: true,
      route: { path: "/list" },
    });
    expect(read('export const prefix = "/shop" as const;', "layout.tsx")).toEqual({
      ok: true,
      prefix: "/shop",
    });
  });

  it("reads a template literal that has no expressions in it", () => {
    expect(read("export const route = `/list`;")).toEqual({ ok: true, route: { path: "/list" } });
  });

  it("keeps a type annotation out of the way", () => {
    expect(read('export const route: PageRoute = { path: "/list" };')).toEqual({
      ok: true,
      route: { path: "/list" },
    });
  });

  it("reads TSX sources, and reports neither export when the file declares neither", () => {
    expect(
      read("export default function Page() { return <div>hi</div>; }", "page.tsx"),
    ).toEqual({ ok: true });
  });

  it("ignores keys it does not know, the same way the server does", () => {
    expect(read('export const route = { path: "/list", title: "Listing" };')).toEqual({
      ok: true,
      route: { path: "/list" },
    });
  });
});

describe("readRouteExports — the forms it rejects", () => {
  const rejected: [label: string, source: string, exportName: "route" | "prefix"][] = [
    ["a function call", 'export const route = buildRoute("/list");', "route"],
    ["an identifier", "export const route = ROUTE;", "route"],
    ["a template literal with an expression", "export const route = `/list/${id}`;", "route"],
    ["a spread inside the object", 'export const route = { ...base, path: "/list" };', "route"],
    ["a computed path value", "export const route = { path: basePath };", "route"],
    ["a computed key", 'export const route = { [key]: "/list" };', "route"],
    ["an object with no path", 'export const route = { name: "shop.list" };', "route"],
    ["a computed prefix", "export const prefix = base + `/shop`;", "prefix"],
    ["a re-exported binding", 'const route = "/list";\nexport { route };', "route"],
  ];

  for (const [label, source, exportName] of rejected) {
    it(`rejects ${label}`, () => {
      const result = read(source);

      expect(result.ok).toBe(false);

      if (result.ok) return;

      expect(result.rejection.exportName).toBe(exportName);
      expect(result.rejection.sourceFile).toBe("src/app/shop/web/list.page.tsx");
      expect(result.rejection.detail).not.toBe("");
    });
  }
});

describe("NonLiteralRouteExportError — what the app developer is told", () => {
  it("names the file, says why a literal is required, and shows one", () => {
    const result = read('export const route = buildRoute("/list");');

    expect(result.ok).toBe(false);

    if (result.ok) return;

    const message = new NonLiteralRouteExportError(result.rejection).message;

    expect(message).toContain("src/app/shop/web/list.page.tsx");
    expect(message).toContain("route");
    expect(message).toContain("without running your application code");
    expect(message).toContain('export const route = "/list"');
  });

  it("shows a prefix example when it is the prefix that could not be read", () => {
    const result = read("export const prefix = base;", "src/app/shop/web/layout.tsx");

    expect(result.ok).toBe(false);

    if (result.ok) return;

    const message = new NonLiteralRouteExportError(result.rejection).message;

    expect(message).toContain("src/app/shop/web/layout.tsx");
    expect(message).toContain('export const prefix = "/shop"');
  });
});
