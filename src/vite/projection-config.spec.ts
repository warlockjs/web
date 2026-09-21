import path from "node:path";
import { describe, expect, it } from "vitest";
import { projection } from "./projection";

const context = {
  error(message: string): never {
    throw new Error(message);
  },
};

async function transform(
  source: string,
  name = "post.page.tsx",
  ssr = false,
): Promise<string | null> {
  const plugin = projection();
  const hook = plugin.transform as unknown as (
    this: typeof context,
    code: string,
    id: string,
    options?: { ssr?: boolean },
  ) => Promise<any>;
  const result = await hook.call(context, source, path.join("/app/web", name), { ssr });
  return result === null ? null : typeof result === "string" ? result : result.code;
}

describe("projection config fence", () => {
  it("removes config, its secret import, and its local validation helper", async () => {
    const code = await transform(
      [
        `import { secret } from "./server-secret";`,
        `import { v } from "./schema";`,
        `const validation = { query: v.object({ token: v.string() }) };`,
        `export const config = { route: "/posts", validation, middleware: [secret] } satisfies PageConfig;`,
        `export const loader = () => ({ title: "Post" });`,
        `export function register() { return undefined; }`,
        `export function ErrorBoundary() { return <p>failed</p>; }`,
        `export default function Post() { return <h1>Post</h1>; }`,
      ].join("\n"),
    );

    expect(code).not.toContain("server-secret");
    expect(code).not.toContain("const validation");
    expect(code).not.toContain("export const config");
    expect(code).not.toContain("export const loader");
    expect(code).toContain("export function register");
    expect(code).toContain("export function ErrorBoundary");
    expect(code).toContain("export default function Post");
  });

  it("refuses a client-reachable config binding, including through a helper alias", async () => {
    await expect(
      transform(
        [
          `export const config = { route: "/posts" };`,
          `const clientValue = config;`,
          `export default function Post() { return <p>{clientValue.route}</p>; }`,
        ].join("\n"),
      ),
    ).rejects.toThrow(/post\.page\.tsx.*server-only `config` binding/);
  });

  it("strips config and loader from one exported variable declaration", async () => {
    const code = await transform(
      `export const config = { route: "/posts" }, loader = () => ({ title: "Post" }); export default () => null;`,
    );
    expect(code).not.toContain("config =");
    expect(code).not.toContain("loader =");
  });

  it("keeps a universal co-declarator and its import when config is removed", async () => {
    const code = await transform(
      [
        `import { clientValue } from "./client-value";`,
        `export const config = { route: "/posts" }, register = () => clientValue;`,
        `export default () => null;`,
      ].join("\n"),
    );
    expect(code).not.toContain("config =");
    expect(code).toContain("export const register = () => clientValue");
    expect(code).toContain('from "./client-value"');
  });

  it("refuses a surviving co-declarator that reads config", async () => {
    await expect(
      transform(
        `export const config = { route: "/posts" }, register = () => config; export default () => null;`,
      ),
    ).rejects.toThrow(/server-only `config` binding/);
  });

  it.each(["(config as any)", "(config satisfies unknown)", "config!"])(
    "refuses config reads inside TypeScript wrappers: %s",
    async (expression) => {
      await expect(
        transform(`export const config = {}; export default () => ${expression};`),
      ).rejects.toThrow(/server-only `config` binding/);
    },
  );

  it("does not mistake member properties, type queries, or shadowed values for the config export", async () => {
    const code = await transform(
      [
        `export const config = { route: "/posts" };`,
        `type ConfigType = typeof config;`,
        `const settings = { config: "client" };`,
        `export default function Post(config: { title: string }) { return <p>{settings.config}{config.title}</p>; }`,
      ].join("\n"),
    );
    expect(code).not.toContain("export const config");
    expect(code).toContain("settings.config");
    expect(code).toContain("function Post(config");
  });

  it("allows config shadows in methods, catches, loops, and static blocks", async () => {
    const code = await transform(
      [
        `export const config = { route: "/posts" };`,
        `export default class Post {`,
        `  static { const config = "local"; this.value = config; }`,
        `  method(config: string) { try { return config; } catch (config) { return config; } }`,
        `  loop() { for (const config of ["local"]) return config; }`,
        `}`,
      ].join("\n"),
    );
    expect(code).not.toContain("export const config");
    expect(code).toContain("method(config");
  });

  it("still refuses config in a for-of right-hand expression", async () => {
    await expect(
      transform(
        `export const config = { route: "/posts" }; export default () => { for (const item of config.items) return item; };`,
      ),
    ).rejects.toThrow(/server-only `config` binding/);
  });

  it("validates legacy exports before returning an SSR module untouched", async () => {
    await expect(
      transform(`export const route = "/old"; export default () => null;`, "post.page.tsx", true),
    ).rejects.toThrow(/post\.page\.tsx.*runtime export `route` is not allowed/);
  });
});
