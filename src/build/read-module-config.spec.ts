import { describe, expect, it } from "vitest";
import { readModuleConfig } from "./read-module-config";

const pageFile = "src/pages/example.page.tsx";
const page = (source: string) => readModuleConfig(pageFile, source, "page");
const component = "const Page = () => null;";

describe("readModuleConfig — accepted modules", () => {
  it("reads direct and nested wrapped route literals", () => {
    expect(
      page(
        `${component} export const config = ({ route: ({ path: "/posts", name: "posts" } as const) satisfies RouteDeclaration, middleware: guard } as const) satisfies PageConfig; export default Page;`,
      ),
    ).toEqual({ route: { path: "/posts", name: "posts" }, hasMiddleware: true, hasDefault: true });
    expect(
      page(
        `${component} export const config = { route: "/posts", metadata: metadata }; export default Page;`,
      ),
    ).toEqual({ route: { path: "/posts" }, hasMiddleware: false, hasDefault: true });
    expect(
      page(`${component} export const config = { route: \`/template\` }; export default Page;`),
    ).toEqual({ route: { path: "/template" }, hasMiddleware: false, hasDefault: true });
  });

  it("does not evaluate helper values and accepts page metadata methods", () => {
    expect(
      page(
        `${component} export const config = { cache: cachePolicy, validation: schemaFor(Page), metadata(props) { return { title: props.title }; }, sitemap: makeSitemap }; export default Page;`,
      ),
    ).toEqual({ hasMiddleware: false, hasDefault: true });
  });

  it("allows erased types, known re-exports, and function-form runtime exports", () => {
    expect(
      page(
        "interface PageConfig {} export type { PageConfig }; export type * from './types'; export { default as default, loader, register, ErrorBoundary } from './page-runtime'; export const config = {}; ",
      ),
    ).toEqual({ hasMiddleware: false, hasDefault: true });
    expect(
      page(
        `${component} export const config = {}; export async function loader() {} export function register() {} export function ErrorBoundary() { return null; } export default Page;`,
      ),
    ).toEqual({ hasMiddleware: false, hasDefault: true });
  });

  it("reads layout and root schemas", () => {
    expect(
      readModuleConfig(
        "layout.tsx",
        'export const config = { prefix: "/admin", middleware: undefined, metadata: metadata };',
        "layout",
      ),
    ).toEqual({ prefix: "/admin", hasMiddleware: true, hasDefault: false });
    expect(
      readModuleConfig("root.tsx", "export const config = { middleware: guard };", "root"),
    ).toEqual({ hasMiddleware: true, hasDefault: false });
  });
});

describe("readModuleConfig — rejected modules", () => {
  it.each([
    [
      "a computed config key",
      `${component} export const config = { [key]: value }; export default Page;`,
      "computed key",
    ],
    [
      "a config spread",
      `${component} export const config = { ...base }; export default Page;`,
      "config cannot spread",
    ],
    [
      "a duplicate config key",
      `${component} export const config = { cache: one, cache: two }; export default Page;`,
      "declares `cache` more than once",
    ],
    [
      "a computed route key",
      `${component} export const config = { route: { [key]: "/x" } }; export default Page;`,
      "computed key",
    ],
    [
      "a route spread",
      `${component} export const config = { route: { ...base, path: "/x" } }; export default Page;`,
      "config.route cannot spread",
    ],
    [
      "a duplicate route key",
      `${component} export const config = { route: { path: "/x", path: "/y" } }; export default Page;`,
      "config.route declares `path` more than once",
    ],
    [
      "an unknown route key",
      `${component} export const config = { route: { path: "/x", cache: true } }; export default Page;`,
      "config.route has unknown key `cache`",
    ],
    [
      "a route with no path",
      `${component} export const config = { route: { name: "x" } }; export default Page;`,
      "must declare a literal `path`",
    ],
    [
      "a computed route value",
      `${component} export const config = { route: makeRoute() }; export default Page;`,
      "config.route` export must be a directly exported object literal",
    ],
    [
      "a template route with an expression",
      `${component} export const config = { route: \`/posts/\${id}\` }; export default Page;`,
      "config.route` export must be a directly exported object literal",
    ],
    [
      "an unknown config field",
      `${component} export const config = { route: "/x", prefix: "/x" }; export default Page;`,
      "not allowed in a page module",
    ],
    [
      "a legacy runtime export",
      `${component} export const metadata = {}; export default Page;`,
      "runtime export `metadata` is not allowed",
    ],
    [
      "an unknown runtime export",
      `${component} export const legacy = 1; export default Page;`,
      "runtime export `legacy` is not allowed",
    ],
    [
      "a config export alias",
      `${component} const config = {}; export { config }; export default Page;`,
      "config` export cannot use an export list",
    ],
    [
      "a config factory",
      `${component} export const config = createConfig(); export default Page;`,
      "config` export must be a directly exported object literal",
    ],
    [
      "config destructuring",
      `${component} export const { config } = source; export default Page;`,
      "runtime exports cannot use destructuring",
    ],
    [
      "an export star",
      `${component} export * from "./legacy"; export default Page;`,
      "export-star declarations are not allowed",
    ],
    [
      "a namespace re-export",
      `${component} export * as loader from "./runtime"; export default Page;`,
      "namespace re-exports are not allowed",
    ],
    [
      "a route method",
      `${component} export const config = { route() { return "/x"; } }; export default Page;`,
      "config.route must be a property value",
    ],
    [
      "a metadata accessor",
      `${component} export const config = { get metadata() { return {}; } }; export default Page;`,
      "accessor or method",
    ],
  ])("rejects %s", (_label, source, diagnostic) => {
    expect(() => page(source)).toThrow(diagnostic);
  });

  it("names the source file for a missing page default", () => {
    expect(() => page("export const config = {};")).toThrow(
      `Cannot read module config in "${pageFile}": a page module requires a runtime default export.`,
    );
  });

  it("rejects a layout metadata method", () => {
    expect(() =>
      readModuleConfig(
        "layout.tsx",
        "export const config = { metadata() { return {}; } };",
        "layout",
      ),
    ).toThrow("accessor or method");
  });

  it("requires a literal layout prefix", () => {
    expect(() =>
      readModuleConfig("layout.tsx", "export const config = { prefix: base };", "layout"),
    ).toThrow("config.prefix must be a string literal");
  });
});
