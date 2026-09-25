import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webHomePageStub, webHomeRegisterStub } from "@warlock.js/core/src/generations/stubs";
import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";
import { projectModule, projection } from "./projection";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR = path.join(__dirname, "..", "..", "__tests__", "vite", "fixtures", "projection");

/**
 * A minimal stand-in for Rollup's plugin `this` context: only `error`,
 * which is the one method `projection()`'s `transform` hook calls, and
 * which — like the real Rollup one — throws.
 */
const pluginContext = {
  error(message: string): never {
    throw new Error(message);
  },
};

type TransformHook = (
  this: typeof pluginContext,
  code: string,
  id: string,
  options?: { ssr?: boolean },
) => Promise<{ code: string; map: unknown } | string | null>;

/**
 * Invokes the REAL `transform` hook Vite would call — not a reimplementation
 * of the AST logic — and hands back whatever it returns, so every assertion
 * below reads the actual transformed output source (`kepler-D2-projection-brief.md`:
 * "verify on the actual transformed OUTPUT source ... never by asserting the
 * AST manipulation logic in isolation").
 */
async function runTransform(fileName: string, options?: { ssr?: boolean }) {
  const id = path.join(FIXTURE_DIR, fileName);
  const code = readFileSync(id, "utf-8");
  const plugin: Plugin = projection();
  const hook = plugin.transform as unknown as TransformHook;
  const result = await hook.call(pluginContext, code, id, options);
  return { id, result };
}

async function transformedCode(fileName: string): Promise<string> {
  const { result } = await runTransform(fileName);
  if (result === null) throw new Error(`expected ${fileName} to be transformed, got null`);
  return typeof result === "string" ? result : result.code;
}

/**
 * Same REAL `transform` hook, source supplied inline instead of from a fixture
 * file. The id still has to be a projectable BASENAME — that is what
 * `isProjectableFile` selects on, and it is the only thing the hook reads the
 * id for besides the error message.
 *
 * Inline rather than on disk because the cases below are about the SHAPE of a
 * module-scope declaration, and reading the shape next to its assertion is what
 * makes each one legible; the fixtures earlier in this file stay where they are.
 */
async function transformSource(source: string, baseName: string): Promise<string> {
  const id = path.join(FIXTURE_DIR, baseName);
  const plugin: Plugin = projection();
  const hook = plugin.transform as unknown as TransformHook;
  const result = await hook.call(pluginContext, source, id);
  if (result === null) throw new Error(`expected ${baseName} to be transformed, got null`);
  return typeof result === "string" ? result : result.code;
}

function projectSource(source: string, baseName: string): string {
  return projectModule(source, path.join(FIXTURE_DIR, baseName)).code;
}

async function refusalMessage(source: string, baseName: string): Promise<string> {
  try {
    await transformSource(source, baseName);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`expected ${baseName} to be refused, but it transformed cleanly`);
}

describe("projection — strip server config (real transform hook, real output)", () => {
  it("case 1: a shared import between loader and the component survives; config and loader are gone", async () => {
    const code = await transformedCode("case1-shared-import.page.tsx");

    expect(code).toContain('from "./helper"');
    expect(code).not.toMatch(/export const config/);
    expect(code).not.toMatch(/export const loader/);
    expect(code).toContain("export default function BlogPage");
    expect(code).toContain("formatTitle(data.title)");
  });

  it("case 2: an import used only inside loader is transitively removed", async () => {
    const code = await transformedCode("case2-orphaned-import.page.tsx");

    expect(code).not.toContain("server-only-helper");
    expect(code).not.toMatch(/export const loader/);
    expect(code).not.toContain("fetchDraftStats");
    expect(code).toContain("export default function BlogPage");
  });

  it("case 3: a bare CSS import survives projection untouched", async () => {
    const code = await transformedCode("case3-css-import.page.tsx");

    expect(code).toContain('import "./styles.css"');
    expect(code).not.toMatch(/export const config/);
    expect(code).not.toMatch(/export const loader/);
  });

  it("case 4: a top-level statement outside any export fails the build, naming file/statement/fix", async () => {
    const id = path.join(FIXTURE_DIR, "case4-ambiguous-statement.page.tsx");

    try {
      await runTransform("case4-ambiguous-statement.page.tsx");
      expect.unreachable("expected the transform to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(id);
      expect(message).toContain('console.log("boot")');
      expect(message).toContain("Cause:");
      expect(message).toContain("Fix:");
    }
  });

  it("case 5: `export async function loader(...)` (function-declaration form) is stripped correctly", async () => {
    const code = await transformedCode("case5-function-loader.page.tsx");

    expect(code).not.toMatch(/export async function loader/);
    expect(code).not.toMatch(/async function loader\(/);
    expect(code).toContain("export default function BlogPage");
  });

  it("validates but skips projection in SSR, where the server needs config intact", async () => {
    const { result } = await runTransform("case1-shared-import.page.tsx", { ssr: true });
    expect(result).toBeNull();
  });

  it("ignores files that are not *.page.tsx/layout.tsx/root.tsx", async () => {
    const { result } = await runTransform("helper.ts");
    expect(result).toBeNull();
  });

  /**
   * THE APP ROOT, which until now was named in a test title and exercised by
   * none.
   *
   * The negative test above says it "ignores files that are not
   * *.page.tsx/layout.tsx/root.tsx" — but its body runs `helper.ts`, so it
   * passes whatever that title claims. `isProjectableFile` recognises a root by
   * EXACT BASENAME rather than by a suffix, which makes it the one branch a
   * rename silently disables: the root would stop being projected, its
   * `config` and `loader` would ship to the browser, and the
   * whole suite would stay green.
   *
   * So this asserts the positive case, on real transformed output.
   */
  it("projects the APP ROOT by name — its server exports do not reach the browser", async () => {
    const code = await transformedCode("root.tsx");

    expect(code).not.toMatch(/export const config/);
    expect(code).not.toMatch(/export const loader/);
    expect(code).toContain("export default function App");
  });

  it("refuses the removed `revalidate` runtime export", async () => {
    const message = await refusalMessage(
      `export const revalidate = false; export default function App() { return null; }`,
      "root.tsx",
    );
    expect(message).toContain("runtime export `revalidate` is not allowed");
  });

  it("drops the root's server-only import once the exports using it are gone", async () => {
    /*
      Stripping the exports is only half of it. An import that existed solely to
      feed `middleware` has to go with it, or the browser bundle still pulls the
      server module in and Gate A refuses the build for a symbol nobody uses.
      The import the COMPONENT shares stays, which is what makes this an
      assertion about attribution rather than about deleting imports.
    */
    const code = await transformedCode("root.tsx");

    // Matched as an IMPORT STATEMENT, not as the bare name: the fixture's own
    // comments mention the module, and a loose `/server-only-helper/` passes or
    // fails on prose rather than on what projection removed.
    expect(code).not.toMatch(/from ["']\.\/server-only-helper["']/);
    expect(code).toContain('from "./helper"');
  });
});

describe("projection — import binding liveness", () => {
  it("drops a metadata-only Core import when client scopes shadow its local name", async () => {
    const code = await transformSource(
      [
        `import { t } from "@warlock.js/core";`,
        `import { useTrans } from "@warlock.js/web";`,
        ``,
        `export const config = { metadata: () => ({ title: t("posts.title") }) };`,
        ``,
        `export default function PostsPage() {`,
        `  const t = useTrans();`,
        `  const render = ({ t }: { t: (key: string) => string }) => <p>{t("posts.card")}</p>;`,
        `  try { throw useTrans(); } catch ({ t }) { return <>{t("posts.error")}</>; }`,
        `  return <section>{t("posts.heading")}{render({ t })}</section>;`,
        `}`,
      ].join("\n"),
      "posts.page.tsx",
    );

    expect(code).not.toMatch(/from ["']@warlock\.js\/core["']/);
    expect(code).toContain('from "@warlock.js/web"');
    expect(code).toContain("const t = useTrans()");
  });

  it("keeps a genuinely read import, including property and JSX references", async () => {
    const code = await transformSource(
      [
        `import { clientConfig, Card, Header, lookupKey } from "./client-safe";`,
        ``,
        `export const config = { metadata: () => ({ title: "server only" }) };`,
        ``,
        `export default function PostsPage() {`,
        `  return <Card.Header title={clientConfig[lookupKey]} />;`,
        `}`,
      ].join("\n"),
      "posts.page.tsx",
    );

    expect(code).toMatch(/from ["']\.\/client-safe["']/);
    expect(code).toContain("clientConfig[lookupKey]");
    expect(code).toContain("<Card.Header");
  });

  it("does not confuse block, parameter, or destructuring bindings with an import", async () => {
    const code = await transformSource(
      [
        `import { t } from "@warlock.js/core";`,
        `import { useTrans } from "@warlock.js/web";`,
        ``,
        `export const config = { metadata: () => ({ title: t("posts.title") }) };`,
        ``,
        `export default function PostsPage() {`,
        `  const fromParameter = (t: (key: string) => string) => t("posts.parameter");`,
        `  const fromDestructure = ({ t }: { t: (key: string) => string }) => t("posts.destructure");`,
        `  if (true) { const t = useTrans(); return <>{t("posts.block")}</>; }`,
        `  return <>{fromParameter(useTrans())}{fromDestructure({ t: useTrans() })}</>;`,
        `}`,
      ].join("\n"),
      "posts.page.tsx",
    );

    expect(code).not.toMatch(/from ["']@warlock\.js\/core["']/);
    expect(code).toContain('from "@warlock.js/web"');
  });

  it("treats a default parameter as its own binding scope", async () => {
    const code = await transformSource(
      [
        `import { t } from "@warlock.js/core";`,
        `import { useTrans } from "@warlock.js/web";`,
        ``,
        `export const config = { metadata: () => ({ title: t("posts.title") }) };`,
        ``,
        `export default function PostsPage(t = useTrans()) {`,
        `  return <h1>{t("posts.parameter")}</h1>;`,
        `}`,
      ].join("\n"),
      "posts.page.tsx",
    );

    expect(code).not.toMatch(/from ["']@warlock\.js\/core["']/);
    expect(code).toContain('from "@warlock.js/web"');
  });

  it("keeps an imported local re-export and ignores a removed mixed config declarator", async () => {
    const code = projectSource(
      [
        `import { configOnly } from "./config-only";`,
        `import { x } from "./values";`,
        ``,
        `export const config = { metadata: () => configOnly("server") }, retained = x;`,
        `export { x };`,
        `export default function PostsPage() { return <p />; }`,
      ].join("\n"),
      "posts.page.tsx",
    );

    expect(code).not.toMatch(/from ["']\.\/config-only["']/);
    expect(code).toMatch(/from ["']\.\/values["']/);
    expect(code).toMatch(/export \{ x \}/);
  });

  it("keeps imports read by computed method and catch-pattern expressions", async () => {
    const code = await transformSource(
      [
        `import { methodName, fallback } from "./client-safe";`,
        ``,
        `export const config = { metadata: () => "server only" };`,
        ``,
        `export default function PostsPage() {`,
        `  const api = { [methodName]() { return "ok"; } };`,
        `  try { throw {}; } catch ({ [fallback]: value = methodName }) { return <p>{api.default()} {value}</p>; }`,
        `}`,
      ].join("\n"),
      "posts.page.tsx",
    );

    expect(code).toMatch(/from ["']\.\/client-safe["']/);
    expect(code).toContain("[methodName]()");
    expect(code).toContain("value = methodName");
  });

  it("uses Babel bindings for JSX attributes, hoisted vars, computed classes, and runtime TS expressions", () => {
    const jsxAttribute = projectSource(
      `import { placeholder } from "./server-only"; export const config = { metadata: () => placeholder }; export default function Page() { return <input placeholder="x" />; }`,
      "page.page.tsx",
    );
    const hoistedVar = projectSource(
      `import { Core } from "./server-only"; export const config = { metadata: () => Core }; export default function Page() { if (true) { var Core = { value: "local" }; } return <p>{Core.value}</p>; }`,
      "page.page.tsx",
    );
    const computedClass = projectSource(
      `import { Base } from "./client-safe"; export const config = { metadata: () => "server" }; export default class Widget { [Base.methodName]() { return 1; } }`,
      "page.page.tsx",
    );
    const runtimeEnum = projectSource(
      `import { Base } from "./client-safe"; export enum Level { Low = Base.LOW } export default function Page() { return <p />; }`,
      "page.page.tsx",
    );
    const runtimeAssertion = projectSource(
      `import { Base } from "./client-safe"; export const config = { metadata: () => "server" }; export default function Page() { return <p>{Base.value as string}</p>; }`,
      "page.page.tsx",
    );
    const typeReexport = projectSource(
      `import { Foo } from "./server-only"; export type { Foo }; export default function Page() { return <p />; }`,
      "page.page.tsx",
    );
    const valueReexport = projectSource(
      `import { Foo } from "./client-safe"; export { Foo }; export default function Page() { return <p />; }`,
      "page.page.tsx",
    );

    expect(jsxAttribute).not.toMatch(/from ["']\.\/server-only["']/);
    expect(hoistedVar).not.toMatch(/from ["']\.\/server-only["']/);
    expect(computedClass).toMatch(/from ["']\.\/client-safe["']/);
    expect(runtimeEnum).toMatch(/from ["']\.\/client-safe["']/);
    expect(runtimeAssertion).toMatch(/from ["']\.\/client-safe["']/);
    expect(typeReexport).not.toMatch(/from ["']\.\/server-only["']/);
    expect(valueReexport).toMatch(/from ["']\.\/client-safe["']/);
  });

  it("keeps a true surviving Core use for Gate A to refuse", async () => {
    const code = await transformSource(
      [
        `import { t } from "@warlock.js/core";`,
        ``,
        `export const config = { metadata: () => ({ title: "server only" }) };`,
        ``,
        `export default function PostsPage() {`,
        `  return <h1>{t("posts.clientLeak")}</h1>;`,
        `}`,
      ].join("\n"),
      "posts.page.tsx",
    );

    expect(code).toMatch(/from ["']@warlock\.js\/core["']/);
    expect(code).toContain('t("posts.clientLeak")');
  });
});

/**
 * `export * from "./source"` was previously treated as always-safe alongside
 * every other export form — but unlike a NAMED export, a star re-export
 * forwards whatever the source module exports, sight unseen. A page that
 * re-exports `* from "./shared-loaders"` would leak `loader`/`middleware`/
 * etc. straight past the 7-name check below it, since projection never opens
 * the source file to see what it actually exports (`304fcc57`). It is now
 * refused the same way any other attribution-ambiguous statement is —
 * through `ProjectionAmbiguityError`, not a second resolution path.
 */
describe("projection — refuses a star re-export rather than assuming it is safe", () => {
  it('refuses `export * from "./source"`, naming the leak risk as the cause', async () => {
    const message = await refusalMessage(
      [
        `export * from "./shared-loaders";`,
        ``,
        `export default function BlogPage() {`,
        `  return <h1>Blog</h1>;`,
        `}`,
      ].join("\n"),
      "blog.page.tsx",
    );

    expect(message).toContain("blog.page.tsx");
    expect(message).toContain("export-star declarations are not allowed");
  });

  it('refuses `export * as ns from "./source"` the same way', async () => {
    const message = await refusalMessage(
      [
        `export * as sharedLoaders from "./shared-loaders";`,
        ``,
        `export default function BlogPage() {`,
        `  return <h1>Blog</h1>;`,
        `}`,
      ].join("\n"),
      "blog.page.tsx",
    );

    expect(message).toContain("blog.page.tsx");
    expect(message).toContain("namespace re-exports are not allowed");
  });

  it("still strips direct config and loader declarations, unaffected by the star-reexport refusal", async () => {
    const code = await transformedCode("case1-shared-import.page.tsx");

    expect(code).not.toMatch(/export const config/);
    expect(code).not.toMatch(/export const loader/);
  });
});

/**
 * `register` is a client-and-server lifecycle hook, not a sixth server export.
 * Projection therefore keeps its named declaration and every dependency the
 * body reads, while still removing the server-only exports beside it. Pin all
 * three projectable entry-point shapes: a basename regression otherwise turns
 * into a hook that works for pages but silently disappears from layouts or the
 * root.
 */
describe("projection — register lifecycle hook", () => {
  it("projects Core's generated Web page without any manual repair", async () => {
    const code = await transformSource(webHomePageStub, "index.page.tsx");

    expect(code).toContain('export { register } from "./index.register";');
    expect(code).not.toContain('extend("en", {');
    expect(webHomeRegisterStub).toContain("export function register()");
    expect(webHomeRegisterStub).toContain('extend("en", {');
    expect(webHomeRegisterStub).toContain('extend("ar", {');
    expect(code).not.toMatch(/export const config/);
    expect(code).not.toMatch(/^export const loader/m);
  });

  it.each([
    ["page", "account.page.tsx"],
    ["layout", "layout.tsx"],
    ["root", "root.tsx"],
  ])(
    "keeps register and its referenced import/declaration in a %s module",
    async (_kind, baseName) => {
      const code = await transformSource(
        [
          `import { install } from "./universal-static";`,
          ``,
          `const registrationName = "catalog";`,
          ``,
          `export const loader = async () => ({ hidden: true });`,
          ``,
          `export function register() {`,
          `  install(registrationName);`,
          `}`,
          ``,
          `export default function Entry() {`,
          `  return <main />;`,
          `}`,
        ].join("\n"),
        baseName,
      );

      expect(code).toContain('from "./universal-static"');
      expect(code).toContain('const registrationName = "catalog"');
      expect(code).toContain("export function register()");
      expect(code).toContain("install(registrationName)");
      expect(code).not.toMatch(/export const loader/);
    },
  );

  it.each([
    ["page", "account.page.tsx"],
    ["layout", "layout.tsx"],
    ["root", "root.tsx"],
  ])(
    "self-accepts a %s replacement through the once-per-namespace registration guard",
    async (_kind, baseName) => {
      const code = await transformSource(
        `export function register() {}\nexport default function Entry() { return <main />; }`,
        baseName,
      );

      expect(code).toContain(
        'import { registerModules as __warlockRegisterModules } from "@warlock.js/web/client/runtime";',
      );
      expect(code).toContain(
        "if (import.meta.hot) import.meta.hot.accept((replacement) => { if (replacement) __warlockRegisterModules([replacement]); });",
      );
      expect(code).not.toContain("replacement?.register?.()");
      expect(code).not.toContain("import.meta.hot.accept(register)");
    },
  );

  it("keeps projected HMR out of SSR and non-projectable modules, so Vite performs its normal full reload", async () => {
    const ssr = await runTransform("case1-shared-import.page.tsx", { ssr: true });
    const nonProjectable = await runTransform("helper.ts");

    expect(ssr.result).toBeNull();
    expect(nonProjectable.result).toBeNull();
  });

  it("teaches register at every ambiguity diagnostic surface", async () => {
    const bareStatement = await refusalMessage(
      `install();\nexport default function Page() { return <main />; }`,
      "register.page.tsx",
    );
    const executableInitializer = await refusalMessage(
      `const installed = install();\nexport default function Page() { return <main />; }`,
      "register.page.tsx",
    );
    const bareImport = await refusalMessage(
      `import "./universal-static";\nexport default function Page() { return <main />; }`,
      "register.page.tsx",
    );

    expect(bareStatement).toContain("export function register()");
    expect(executableInitializer).toContain("export function register()");
    expect(bareImport).toContain("export function register()");
  });
});

/**
 * A page hoists things to MODULE SCOPE for two ordinary reasons, and until now
 * projection refused both of them identically — which is what stopped `v5/app`'s
 * real client build at `products/web/layout.tsx:30` (card `afc42f4b`).
 *
 * The two reasons are not ambiguous, and telling them apart needs no new
 * knowledge: it is the SAME reference-attribution question already answered for
 * import bindings by "case 1" and "case 2" above, asked about the other kind of
 * binding. What follows pins the answer in both directions, plus the cases where
 * the reference graph genuinely cannot answer and the refusal has to stand.
 */
describe("projection — attributing a module-scope declaration by who reads it", () => {
  /**
   * The `v5/app` shape, verbatim in structure: a named middleware whose ONLY
   * reader is `export const middleware`. It is not a contract violation —
   * line 2 puts it in the middleware export; naming the array element is a
   * formatting choice, not a way around the fence.
   */
  it("removes a helper whose only reader is a server export — and the import it held alive", async () => {
    const code = await transformSource(
      [
        `import { readSession } from "./server-only-helper";`,
        `import { formatTitle } from "./helper";`,
        ``,
        `const publishCart = async ({ request }) => {`,
        `  readSession(request);`,
        `};`,
        ``,
        `export const config = { middleware: [publishCart] };`,
        ``,
        `export default function ProductsLayout({ data }) {`,
        `  return <h1>{formatTitle(data.title)}</h1>;`,
        `}`,
      ].join("\n"),
      "layout.tsx",
    );

    expect(code).not.toContain("publishCart");
    expect(code).not.toMatch(/export const config/);
    // The point of removing the helper: the server module it pulled in goes too.
    expect(code).not.toMatch(/from ["']\.\/server-only-helper["']/);
    expect(code).toContain('from "./helper"');
    expect(code).toContain("export default function ProductsLayout");
  });

  /**
   * The other half, and the reason this could never be fixed by making
   * projection stricter about middleware: `v5/app`'s settings page hoists a
   * plain constant and a pure mapper that ONLY the component reads
   * (`settings.page.tsx:118,129`). Refusing these is refusing hoisting itself.
   */
  it("keeps a module-scope constant and helper that the component reads", async () => {
    const code = await transformSource(
      [
        `const COMMON_TIMEZONES = ["UTC", "Africa/Cairo"];`,
        ``,
        `const toOptions = zones => zones.map(zone => ({ value: zone, label: zone }));`,
        ``,
        `export const loader = async () => ({ profile: {} });`,
        ``,
        `export default function AccountSettingsPage() {`,
        `  return <select>{toOptions(COMMON_TIMEZONES).map(o => o.label)}</select>;`,
        `}`,
      ].join("\n"),
      "settings.page.tsx",
    );

    expect(code).toContain("COMMON_TIMEZONES");
    expect(code).toContain("const toOptions");
    expect(code).not.toMatch(/export const loader/);
    expect(code).toContain("export default function AccountSettingsPage");
  });

  /**
   * One pass is not enough. `buildQuery` is reachable only THROUGH `runQuery`,
   * so it only becomes orphaned after `runQuery` is removed — the same
   * transitive shape "case 2" proves for imports, which is why this walks to a
   * fixpoint instead of sweeping once.
   */
  it("removes a chain of server-only helpers transitively", async () => {
    const code = await transformSource(
      [
        `function buildQuery(id) {`,
        `  return { id };`,
        `}`,
        ``,
        `const runQuery = async id => fetch(buildQuery(id));`,
        ``,
        `export const loader = async ({ params }) => runQuery(params.id);`,
        ``,
        `export default function BlogPage() {`,
        `  return <h1>Blog</h1>;`,
        `}`,
      ].join("\n"),
      "blog.page.tsx",
    );

    expect(code).not.toContain("buildQuery");
    expect(code).not.toContain("runQuery");
    expect(code).toContain("export default function BlogPage");
  });

  /**
   * THE FAIL-OPEN GUARD, and the reason "no surviving reader" alone is not the
   * rule. This declaration has no reader anywhere — but its initializer RUNS,
   * so removing it would delete a side effect the browser might be the one that
   * needs, and keeping it would ship server work. Neither is derivable from the
   * reference graph, so the refusal stands and says exactly why.
   */
  it("refuses — does not silently drop — an unread declaration whose initializer executes", async () => {
    const message = await refusalMessage(
      [
        `import { installPolyfill } from "./server-only-helper";`,
        ``,
        `const installed = installPolyfill();`,
        ``,
        `export default function BlogPage() {`,
        `  return <h1>Blog</h1>;`,
        `}`,
      ].join("\n"),
      "blog.page.tsx",
    );

    expect(message).toContain("const installed = installPolyfill();");
    expect(message).toContain("initializer executes code");
    expect(message).toContain("Fix:");
  });

  /**
   * A `class` is never removed even when nothing reads it: static blocks,
   * decorators and computed keys all run at definition time, so a class falls on
   * the "can execute" side by construction rather than by inspecting its body.
   */
  it("refuses an unread top-level class rather than removing it", async () => {
    const message = await refusalMessage(
      [
        `class QueryBuilder {`,
        `  static registry = [];`,
        `}`,
        ``,
        `export default function BlogPage() {`,
        `  return <h1>Blog</h1>;`,
        `}`,
      ].join("\n"),
      "blog.page.tsx",
    );

    expect(message).toContain("class QueryBuilder {");
    expect(message).toContain("Cause:");
  });

  /**
   * The class the COMPONENT uses survives, so the rule above is about
   * attribution and not about a blanket ban on classes.
   */
  it("keeps a top-level class the component reads", async () => {
    const code = await transformSource(
      [
        `class Formatter {`,
        `  format(value) {`,
        `    return String(value);`,
        `  }`,
        `}`,
        ``,
        `export const loader = async () => ({ title: "" });`,
        ``,
        `export default function BlogPage({ data }) {`,
        `  return <h1>{new Formatter().format(data.title)}</h1>;`,
        `}`,
      ].join("\n"),
      "blog.page.tsx",
    );

    expect(code).toContain("class Formatter");
    expect(code).not.toMatch(/export const loader/);
  });

  /**
   * A statement that binds NO name is still a hard refusal — there is no reader
   * to attribute it by, which is a different failure from the ones above and now
   * says so instead of claiming the file holds "executable code outside the 5
   * known server exports" (true of every case in this describe, and the reason
   * the old message read as an internal error).
   */
  it("still refuses a bare top-level statement, naming the absent binding as the cause", async () => {
    const message = await refusalMessage(
      [
        `console.log("boot");`,
        ``,
        `export default function BlogPage() {`,
        `  return <h1>Blog</h1>;`,
        `}`,
      ].join("\n"),
      "blog.page.tsx",
    );

    expect(message).toContain('console.log("boot")');
    expect(message).toContain("declares nothing");
  });

  /**
   * Unchanged and asserted here because this describe is the one that could
   * erode it: attribution decides LOCAL declarations only. A non-server-named
   * EXPORT survives whatever it references, including when
   * nothing in the file reads it.
   */
  it("refuses an unrecognized runtime export", async () => {
    const message = await refusalMessage(
      [
        `export const title = "/products";`,
        ``,
        `export const config = { middleware: [] };`,
        ``,
        `export default function ProductsLayout() {`,
        `  return <main />;`,
        `}`,
      ].join("\n"),
      "layout.tsx",
    );

    expect(message).toContain("runtime export `title` is not allowed");
  });
});

/**
 * `prefix` joined `route`/`middleware`/`validation`/`loader`/`metadata` as a
 * 6th server export (`c438ae61`): a layout's route-prefix declaration is
 * server-side routing data, not something the client needs to read, and
 * until now it survived projection unread — the exact shape the export-list
 * check above pins in the OTHER direction.
 */
describe("projection — strips `config.prefix`", () => {
  it("removes a literal config prefix", async () => {
    const code = await transformSource(
      [
        `export const config = { prefix: "/products" };`,
        ``,
        `export default function ProductsLayout() {`,
        `  return <main />;`,
        `}`,
      ].join("\n"),
      "layout.tsx",
    );

    expect(code).not.toMatch(/export const config/);
    expect(code).toContain("export default function ProductsLayout");
  });

  it("refuses a non-literal config prefix rather than evaluating its import", async () => {
    const message = await refusalMessage(
      [
        `import { basePrefix } from "./server-only-helper";`,
        `import { formatTitle } from "./helper";`,
        ``,
        `export const config = { prefix: basePrefix };`,
        ``,
        `export default function ProductsLayout({ data }) {`,
        `  return <h1>{formatTitle(data.title)}</h1>;`,
        `}`,
      ].join("\n"),
      "layout.tsx",
    );

    expect(message).toContain("config.prefix must be a string literal");
  });
});

/**
 * `sitemap` joined `route`/`middleware`/`validation`/`loader`/`metadata`/
 * `prefix` as a 7th server export (`4344e32a`): a page's per-page sitemap
 * supplier (`export const sitemap = async () => [...]`, web skill
 * generate-sitemap) is documented as server-only — it commonly imports a
 * model that itself imports server-only infrastructure (a decorated
 * `@warlock.js/cascade` model in the reference app) — but until now it
 * survived projection unread, dragging that import into the client graph and
 * crashing Gate B's parser rather than being stripped like the other 6.
 */
describe("projection — strips `config.sitemap`", () => {
  it("removes a config sitemap supplier", async () => {
    const code = await transformSource(
      [
        `export const config = { sitemap: async () => [{ url: "/products" }] };`,
        ``,
        `export default function ProductsPage() {`,
        `  return <main />;`,
        `}`,
      ].join("\n"),
      "products.page.tsx",
    );

    expect(code).not.toMatch(/export const config/);
    expect(code).toContain("export default function ProductsPage");
  });

  it("removes an import held alive only by `sitemap`, including its server model, same as the other 6 server exports", async () => {
    const code = await transformSource(
      [
        `import { Post } from "./models/post/post.model";`,
        `import { formatTitle } from "./helper";`,
        ``,
        `export const config = { sitemap: async () => {`,
        `  const posts = await Post.list();`,
        `  return posts.map(post => ({ url: post.slug }));`,
        `} };`,
        ``,
        `export default function BlogPage({ data }) {`,
        `  return <h1>{formatTitle(data.title)}</h1>;`,
        `}`,
      ].join("\n"),
      "blog.page.tsx",
    );

    expect(code).not.toMatch(/export const config/);
    expect(code).not.toMatch(/from ["']\.\/models\/post\/post\.model["']/);
    expect(code).toContain('from "./helper"');
    expect(code).toContain("export default function BlogPage");
  });
});

/**
 * A type-only import/export is erased at build — TypeScript deletes it before
 * the runtime ever sees it — so it can never smuggle a server module into the
 * client bundle, no matter what it names. Projection must never trip its
 * ambiguity refusal (or the orphan-import removal path) on one of these
 * forms, in `root.tsx` or in any other projectable file.
 *
 * The defect this pins: `import type {} from "./types"` in `root.tsx` fell
 * into the "bare side-effect import" branch (`decl.specifiers.length === 0`)
 * and was REFUSED as attribution-ambiguous, even though a type-only import
 * carries no runtime specifier to be ambiguous about at all.
 *
 * Canon reminder for this file: every boundary defect here so far is one rule
 * inspecting a single FORM while a second form reaches the same place
 * unexamined. `import { type A, B } from "./server-only"` (a value specifier
 * riding alongside a type one) and a plain value import are pinned alongside
 * the type-only forms so the fix can't accidentally widen into "never check
 * imports again."
 */
describe("projection — type-only imports/exports never trip the client boundary", () => {
  it('allows `import type {} from "./types"` — no specifiers, whole-declaration type-only', async () => {
    const code = await transformSource(
      [
        `import type {} from "./types";`,
        ``,
        `export default function App() {`,
        `  return <html />;`,
        `}`,
      ].join("\n"),
      "root.tsx",
    );

    expect(code).toContain('import type {} from "./types"');
    expect(code).toContain("export default function App");
  });

  it('allows `import type { X } from "./server-module"` — named, whole-declaration type-only', async () => {
    const code = await transformSource(
      [
        `import type { X } from "./server-module";`,
        ``,
        `export const loader = async (): Promise<X> => ({}) as X;`,
        ``,
        `export default function BlogPage() {`,
        `  return <h1>Blog</h1>;`,
        `}`,
      ].join("\n"),
      "blog.page.tsx",
    );

    expect(code).toContain('import type { X } from "./server-module"');
    expect(code).not.toMatch(/export const loader/);
    expect(code).toContain("export default function BlogPage");
  });

  it('allows `import { type X } from "./server-module"` — every specifier individually type-only', async () => {
    const code = await transformSource(
      [
        `import { type X } from "./server-module";`,
        ``,
        `export const loader = async (): Promise<X> => ({}) as X;`,
        ``,
        `export default function BlogPage() {`,
        `  return <h1>Blog</h1>;`,
        `}`,
      ].join("\n"),
      "blog.page.tsx",
    );

    expect(code).toContain('import { type X } from "./server-module"');
    expect(code).not.toMatch(/export const loader/);
    expect(code).toContain("export default function BlogPage");
  });

  it('allows `export type { X } from "./server-module"` — re-export, type-only', async () => {
    const code = await transformSource(
      [
        `export type { X } from "./server-module";`,
        ``,
        `export default function BlogPage() {`,
        `  return <h1>Blog</h1>;`,
        `}`,
      ].join("\n"),
      "blog.page.tsx",
    );

    expect(code).toContain('export type { X } from "./server-module"');
    expect(code).toContain("export default function BlogPage");
  });

  it('still checks the VALUE half of a mixed `import { type A, B } from "./server-only"` and removes it when unused', async () => {
    const code = await transformSource(
      [
        `import { type A, B } from "./server-only";`,
        ``,
        `export default function BlogPage() {`,
        `  return <h1>Blog</h1>;`,
        `}`,
      ].join("\n"),
      "blog.page.tsx",
    );

    expect(code).not.toMatch(/from ["']\.\/server-only["']/);
    expect(code).toContain("export default function BlogPage");
  });

  it("still refuses a plain, fully-unused value import the same as before — the fix does not widen into never checking imports", async () => {
    const message = await refusalMessage(
      [
        `import "./server-only-side-effect";`,
        ``,
        `export default function BlogPage() {`,
        `  return <h1>Blog</h1>;`,
        `}`,
      ].join("\n"),
      "blog.page.tsx",
    );

    expect(message).toContain('import "./server-only-side-effect"');
    expect(message).toContain("bare side-effect import");
  });

  it("still removes an ordinary unused VALUE import (no type involved at all)", async () => {
    const code = await transformSource(
      [
        `import { readSession } from "./server-only-helper";`,
        ``,
        `export default function BlogPage() {`,
        `  return <h1>Blog</h1>;`,
        `}`,
      ].join("\n"),
      "blog.page.tsx",
    );

    expect(code).not.toMatch(/from ["']\.\/server-only-helper["']/);
  });
});

/**
 * `isServerExportDeclaration` only recognizes the DECLARATION form (`export
 * const sitemap = ...` / `export async function loader() {}`). A page can
 * equally reach a server name through a RE-EXPORT — `export { x as sitemap }
 * from "m"` or `export { x as sitemap }` locally — which is a second form
 * reaching the same place unexamined (canon `1ca1e8ae`). These pin that
 * projection strips the specifier (and, when it was the only reason to import
 * the source module, the module edge itself) for every one of the 7 server
 * export names, the same as the declaration form already does.
 */
describe("projection — re-export surface", () => {
  it("refuses legacy server re-exports", async () => {
    const message = await refusalMessage(
      `export { postSitemapEntries as sitemap } from "./post-sitemap-entries";\nexport default function PostPage() { return <article />; }`,
      "post.page.tsx",
    );
    expect(message).toContain("runtime export `sitemap` is not allowed");
  });

  it('drops an unrenamed re-export-with-source specifier ("export { loader } from") and the source module edge', async () => {
    const code = await transformSource(
      [
        `export { loader } from "./post-loader";`,
        ``,
        `export default function PostPage() {`,
        `  return <article />;`,
        `}`,
      ].join("\n"),
      "post.page.tsx",
    );

    expect(code).not.toMatch(/\bloader\b/);
    expect(code).not.toMatch(/from ["']\.\/post-loader["']/);
  });

  it("keeps the universal `register` co-export while stripping `loader`", async () => {
    const code = await transformSource(
      [
        `export { loader, register } from "./post-loader";`,
        ``,
        `export default function PostPage() {`,
        `  return <article />;`,
        `}`,
      ].join("\n"),
      "post.page.tsx",
    );

    expect(code).not.toMatch(/export \{[^}]*\bloader\b/);
    expect(code).toContain('export { register } from "./post-loader";');
  });

  it.each(["route", "middleware", "validation", "metadata", "prefix", "sitemap"])(
    "refuses legacy %s re-exports",
    async (name) => {
      const message = await refusalMessage(
        `export { ${name}Impl as ${name} } from "./post-${name}";\nexport default function PostPage() { return <article />; }`,
        "post.page.tsx",
      );
      expect(message).toContain(`runtime export \`${name}\` is not allowed`);
    },
  );

  it("does not silently pass a server export through `export * from` — it stays refused the same as any other star re-export (ruling requested from @Suki, see task report)", async () => {
    const message = await refusalMessage(
      [
        `export * from "./post-sitemap-entries";`,
        ``,
        `export default function PostPage() {`,
        `  return <article />;`,
        `}`,
      ].join("\n"),
      "post.page.tsx",
    );

    expect(message).toContain("export-star declarations are not allowed");
  });
});

describe("projection page actions", () => {
  it("strips action and actions exports from the client output", () => {
    const one = projectSource(
      `export const config = {};\nexport async function action() { return 1; }\nexport default function P() { return null; }\n`,
      "act-one.page.tsx",
    );
    expect(one).not.toMatch(/\baction\b/);
    const many = projectSource(
      `export const actions = { async save() { return 1; } };\nexport default function P() { return null; }\n`,
      "act-many.page.tsx",
    );
    expect(many).not.toMatch(/\bactions\b/);
  });

  it("keeps a UI file using useActionData<typeof action>() with the action stripped", () => {
    const out = projectSource(
      `import { useActionData } from "@warlock.js/web";\nexport async function action() { return { ok: true }; }\nexport default function P() { const r = useActionData<typeof action>(); return r; }\n`,
      "act-typeof.page.tsx",
    );
    expect(out).toContain("useActionData");
    expect(out).not.toMatch(/function action\b/);
  });
});
