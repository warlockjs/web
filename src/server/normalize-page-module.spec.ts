import { BaseValidator } from "@warlock.js/seal";
import { describe, expect, it, vi } from "vitest";
import { InvalidPageModuleConfigError, normalizePageModule } from "./normalize-page-module";

const validator = Object.create(BaseValidator.prototype) as BaseValidator;
const Page = () => null;
const Boundary = () => null;
const loader = () => undefined;
const register = () => undefined;

function page(config: Record<string, unknown> = {}) {
  return { config, default: Page, loader, register, ErrorBoundary: Boundary };
}

describe("normalizePageModule", () => {
  it("treats an omitted config export as an empty config", () => {
    expect(normalizePageModule({ default: Page }, "page", "src/web/plain.page.tsx")).toEqual({
      default: Page,
    });
    expect(normalizePageModule({}, "layout", "src/web/layout.tsx")).toEqual({});
    expect(normalizePageModule({}, "root", "src/web/root.tsx")).toEqual({});
    expect(() =>
      normalizePageModule({ config: undefined, default: Page }, "page", "bad.page.tsx"),
    ).toThrow("config export");
  });

  it("projects allowed page settings without changing its raw namespace", () => {
    const raw = page({
      route: { path: "/products", name: "products" },
      cache: { public: true, maxAge: 60, serverCache: true, tags: ["products"] },
      middleware: [() => undefined],
      validation: { params: validator },
      metadata: { title: "Products" },
      sitemap: false,
    });
    const config = raw.config;
    const configKeys = Object.keys(config);

    const normalized = normalizePageModule(raw, "page", "src/web/products.page.tsx");

    expect(normalized).toMatchObject({
      route: { path: "/products", name: "products" },
      cache: raw.config.cache,
      middleware: raw.config.middleware,
      validation: raw.config.validation,
      metadata: raw.config.metadata,
      sitemap: false,
      default: Page,
      loader,
      register,
      ErrorBoundary: Boundary,
    });
    expect("config" in normalized).toBe(false);
    expect(raw.config).toBe(config);
    expect(Object.keys(raw.config)).toEqual(configKeys);
    expect(normalized).not.toBe(raw);
  });

  it("accepts a page entries declaration and refuses invalidation without a supplier", () => {
    const model = { events: () => ({ on: () => () => {} }) };
    const entries = () => [{ path: "/products/one" }];

    expect(
      normalizePageModule(
        page({ sitemap: { entries, locales: false, invalidateOn: [model] } }),
        "page",
        "src/web/products.page.tsx",
      ).sitemap,
    ).toMatchObject({ entries, locales: false, invalidateOn: [model] });
    expect(() =>
      normalizePageModule(
        page({ sitemap: { invalidateOn: [model] } }),
        "page",
        "src/web/products.page.tsx",
      ),
    ).toThrow(/invalidateOn requires config\.sitemap\.entries/);
  });

  it("accepts memo and forward-ref component objects without invoking them", () => {
    const memo = { $$typeof: Symbol.for("react.memo") };
    const forwardRef = { $$typeof: Symbol.for("react.forward_ref") };

    expect(
      normalizePageModule({ config: {}, default: memo }, "page", "memo.page.tsx").default,
    ).toBe(memo);
    expect(
      normalizePageModule(
        { config: {}, default: Page, ErrorBoundary: forwardRef },
        "page",
        "forward.page.tsx",
      ).ErrorBoundary,
    ).toBe(forwardRef);
  });

  it.each([
    ["an unknown top-level key", { tittle: "Products" }],
    ["a malformed title", { title: 42 }],
    ["an unknown Open Graph key", { openGraph: { headline: "Products" } }],
    ["a malformed Twitter value", { twitter: { card: 42 } }],
    ["malformed keywords", { keywords: ["products", 42] }],
  ])("rejects static metadata with %s", (_case, metadata) => {
    expect(() =>
      normalizePageModule(page({ metadata }), "page", "src/web/metadata.page.tsx"),
    ).toThrow("src/web/metadata.page.tsx");
  });

  it("keeps function metadata lazy and validates its result when invoked", () => {
    const metadata = vi.fn(function (this: { prefix: string }, _context: unknown) {
      return { title: `${this.prefix} Products` };
    });
    const normalized = normalizePageModule(page({ metadata }), "page", "src/web/lazy.page.tsx");

    expect(metadata).not.toHaveBeenCalled();
    expect(typeof normalized.metadata).toBe("function");
    expect((normalized.metadata as Function).call({ prefix: "New" }, {})).toEqual({
      title: "New Products",
    });
    expect(metadata).toHaveBeenCalledTimes(1);
  });

  it.each(["page", "layout", "root"] as const)(
    "admits structured static metadata on a %s module",
    (kind) => {
      const raw =
        kind === "page"
          ? page({ metadata: { title: { default: "Products", template: "%s | Shop" } } })
          : {
              config: {
                ...(kind === "root" ? { strictMode: true } : {}),
                metadata: { title: { absolute: "Account" }, robots: "noindex" },
              },
            };

      expect(normalizePageModule(raw, kind, `${kind}.tsx`).metadata).toEqual(raw.config.metadata);
    },
  );

  it.each([
    ["mixed absolute and template", { title: { absolute: "Account", template: "%s | App" } }],
    ["unknown title key", { title: { default: "Account", suffix: "App" } }],
    ["non-string default", { title: { default: 42 } }],
  ])("rejects %s structured metadata titles", (_case, metadata) => {
    expect(() => normalizePageModule(page({ metadata }), "page", "src/web/title.page.tsx")).toThrow(
      "src/web/title.page.tsx",
    );
  });

  it.each(["layout", "root"] as const)(
    "keeps %s metadata callbacks unexecuted until the metadata stage",
    (kind) => {
      const metadata = vi.fn(() => ({ title: "later" }));
      const raw = { config: { metadata } };

      const normalized = normalizePageModule(raw, kind, `${kind}.tsx`);

      expect(metadata).not.toHaveBeenCalled();
      expect((normalized.metadata as Function)({})).toEqual({ title: "later" });
      expect(metadata).toHaveBeenCalledOnce();
    },
  );

  it("names the page when a lazy metadata function returns malformed output", () => {
    const normalized = normalizePageModule(
      page({ metadata: () => ({ openGraph: { image: 42 } }) }),
      "page",
      "src/web/lazy-invalid.page.tsx",
    );

    expect(() => (normalized.metadata as Function)({})).toThrow("src/web/lazy-invalid.page.tsx");
  });

  it.each([
    ["legacy export", { ...page(), route: "/legacy" }],
    ["unknown config key", page({ routes: "/nope" })],
    ["missing page default", { config: {} }],
    ["non-function middleware", page({ middleware: ["nope"] })],
    ["mixed validation", page({ validation: { schema: validator, params: validator } })],
    ["empty validation", page({ validation: {} })],
    ["route cache", page({ route: { path: "/x", cache: { public: true, maxAge: 1 } } })],
    ["invalid cache", page({ cache: { public: true, maxAge: Number.NaN } })],
  ])("rejects %s and names the source file", (_case, raw) => {
    expect(() => normalizePageModule(raw, "page", "src/web/bad.page.tsx")).toThrow(
      InvalidPageModuleConfigError,
    );
    expect(() => normalizePageModule(raw, "page", "src/web/bad.page.tsx")).toThrow(
      "src/web/bad.page.tsx",
    );
  });

  it("enforces each kind's exact config schema", () => {
    expect(
      normalizePageModule(
        { config: { middleware: [loader], strictMode: true } },
        "root",
        "root.tsx",
      ),
    ).toMatchObject({
      middleware: [loader],
      strictMode: true,
    });
    expect(
      normalizePageModule(
        {
          config: { prefix: "/shop", metadata: { robots: "noindex" }, sitemap: { priority: 0.5 } },
        },
        "layout",
        "layout.tsx",
      ),
    ).toMatchObject({
      prefix: "/shop",
      metadata: { robots: "noindex" },
      sitemap: { priority: 0.5 },
    });
    expect(() => normalizePageModule({ config: { route: "/" } }, "root", "root.tsx")).toThrow(
      "route",
    );
    expect(() =>
      normalizePageModule({ config: { strictMode: "true" } }, "root", "root.tsx"),
    ).toThrow("config.strictMode must be a boolean");
    expect(() => normalizePageModule(page({ strictMode: true }), "page", "page.tsx")).toThrow(
      "strictMode",
    );
    expect(() =>
      normalizePageModule({ config: { strictMode: true } }, "layout", "layout.tsx"),
    ).toThrow("strictMode");
    expect(() =>
      normalizePageModule(
        { config: { cache: { public: true, maxAge: 1 } } },
        "layout",
        "layout.tsx",
      ),
    ).toThrow("cache");
    expect(
      normalizePageModule({ config: { metadata: { title: "layout" } } }, "layout", "layout.tsx"),
    ).toMatchObject({ metadata: { title: "layout" } });
  });
});

describe("normalizePageModule page actions", () => {
  const action = () => undefined;

  it("accepts an action export or an actions record", () => {
    expect(normalizePageModule({ ...page(), action }, "page", "a.page.tsx")).toMatchObject({
      action,
    });
    const actions = { save: action, remove: action };
    expect(normalizePageModule({ ...page(), actions }, "page", "a.page.tsx")).toMatchObject({
      actions,
    });
  });

  it("refuses action and actions together", () => {
    expect(() =>
      normalizePageModule({ ...page(), action, actions: { save: action } }, "page", "a.page.tsx"),
    ).toThrow("mutually exclusive");
  });

  it("refuses action exports on layouts", () => {
    expect(() => normalizePageModule({ action }, "layout", "layout.tsx")).toThrow("page modules");
  });

  it("validates action names and handler types", () => {
    expect(() =>
      normalizePageModule({ ...page(), actions: { default: action } }, "page", "a.page.tsx"),
    ).toThrow("not a valid action name");
    expect(() =>
      normalizePageModule({ ...page(), actions: { Save: action } }, "page", "a.page.tsx"),
    ).toThrow("not a valid action name");
    expect(() =>
      normalizePageModule({ ...page(), actions: { save: 1 } }, "page", "a.page.tsx"),
    ).toThrow("must be a function");
    expect(() =>
      normalizePageModule({ ...page(), action: "nope" }, "page", "a.page.tsx"),
    ).toThrow("action export must be a function");
  });

  it("validates config.action and config.actions shape", () => {
    const mw = () => undefined;
    expect(
      normalizePageModule(
        { ...page({ action: { validation: validator, middleware: [mw] } }), action },
        "page",
        "a.page.tsx",
      ),
    ).toMatchObject({ actionConfig: { validation: validator, middleware: [mw] } });
    expect(() =>
      normalizePageModule({ ...page({ action: { cache: 1 } }), action }, "page", "a.page.tsx"),
    ).toThrow("unknown key");
    expect(() =>
      normalizePageModule(
        { ...page({ action: { validation: {} } }), action },
        "page",
        "a.page.tsx",
      ),
    ).toThrow("config.action.validation");
    expect(() =>
      normalizePageModule(page({ action: {} }), "page", "a.page.tsx"),
    ).toThrow("requires an action export");
  });

  it("refuses config.actions keys that do not match the exports", () => {
    expect(() =>
      normalizePageModule(
        { ...page({ actions: { save: {}, ghost: {} } }), actions: { save: action } },
        "page",
        "a.page.tsx",
      ),
    ).toThrow("config.actions.ghost");
    expect(
      normalizePageModule(
        { ...page({ actions: { save: { validation: validator } } }), actions: { save: action } },
        "page",
        "a.page.tsx",
      ),
    ).toMatchObject({ actionsConfig: { save: { validation: validator } } });
  });
});
