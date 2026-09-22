import { describe, expect, it, vi } from "vitest";
import type { SharedContext } from "../index";
import type { MetadataContext, MetadataInput, PageMetadata } from "../metadata";
import type { PipelineLoader } from "./execute-page-request";
import { ERROR_PAGE_METADATA, resolvePageMetadata } from "./resolve-page-metadata";

const shared = Object.freeze({}) as Readonly<SharedContext>;
const resolve = (overrides: Partial<Parameters<typeof resolvePageMetadata>[0]> = {}) =>
  resolvePageMetadata({
    metadata: undefined,
    data: undefined,
    error: undefined,
    failed: false,
    shared,
    pagePath: "/",
    ...overrides,
  });

describe("resolvePageMetadata ancestor composition", () => {
  it("calls page then inner-to-root ancestors with their own loader data", () => {
    const calls: string[] = [];
    const page = vi.fn(({ data }) => {
      calls.push(`page:${data.id}`);
      return { title: "Page" };
    }) as unknown as PageMetadata<PipelineLoader>;
    const layout = vi.fn(({ data, child }) => {
      calls.push(`layout:${data.id}:${child?.kind}`);
      return { ...child?.metadata, description: "layout" };
    }) as unknown as PageMetadata<PipelineLoader>;
    const root = vi.fn(({ data, child }) => {
      calls.push(`root:${data.id}:${child?.kind}`);
      return { ...child?.metadata, robots: "noindex" };
    }) as unknown as PageMetadata<PipelineLoader>;

    expect(
      resolve({
        metadata: page,
        data: { id: "page" },
        ancestors: [
          { kind: "root", metadata: root, data: { id: "root" } },
          { kind: "layout", metadata: layout, data: { id: "layout" } },
        ],
      }).metadata,
    ).toEqual({ title: "Page", description: "layout", robots: "noindex" });
    expect(calls).toEqual(["page:page", "layout:layout:page", "root:root:layout"]);
  });

  it("keeps a three-level layout/page child chain while omitting metadata-less layouts", () => {
    const root = vi.fn(() => ({})) as unknown as PageMetadata<PipelineLoader>;
    const outer = vi.fn(({ child }) => {
      expect(child).toMatchObject({ kind: "layout", child: { kind: "page" } });
      return {};
    }) as unknown as PageMetadata<PipelineLoader>;
    resolve({
      metadata: { title: "Page" },
      data: {},
      ancestors: [
        { kind: "root", metadata: root, data: {} },
        { kind: "layout", metadata: outer, data: {} },
        { kind: "layout", metadata: undefined, data: {} },
        { kind: "layout", metadata: { description: "inner" }, data: {} },
      ],
    });
    expect(root).toHaveBeenCalledWith(
      expect.objectContaining({ child: expect.objectContaining({ kind: "layout" }) }),
    );
  });

  it("freezes cloned child snapshots without freezing or mutating author objects", () => {
    const pageMetadata = { title: "Page", openGraph: { image: "page.png" } };
    const layout = vi.fn(({ child }) => {
      expect(Object.isFrozen(child)).toBe(true);
      expect(Object.isFrozen(child?.metadata)).toBe(true);
      expect(Object.isFrozen(child?.metadata.openGraph)).toBe(true);
      expect(child?.metadata).not.toBe(pageMetadata);
      return {};
    }) as unknown as PageMetadata<PipelineLoader>;
    resolve({
      metadata: pageMetadata,
      data: {},
      ancestors: [{ kind: "layout", metadata: layout, data: {} }],
    });
    expect(Object.isFrozen(pageMetadata)).toBe(false);
    expect(Object.isFrozen(pageMetadata.openGraph)).toBe(false);
  });

  it("merges OG/Twitter objects, replaces arrays, and permits explicit callback composition", () => {
    const layout = (({ child }) => ({
      ...child?.metadata,
      keywords: ["layout"],
      openGraph: { type: "article", image: "layout.png", ...child?.metadata.openGraph },
      twitter: { card: "summary", image: "layout.png", ...child?.metadata.twitter },
      description: `${child?.metadata.title} details`,
    })) as PageMetadata<PipelineLoader>;
    expect(
      resolve({
        metadata: {
          title: "Page",
          keywords: ["page"],
          openGraph: { image: "page.png" },
          twitter: { title: "tweet" },
        },
        data: {},
        ancestors: [{ kind: "layout", metadata: layout, data: {} }],
      }).metadata,
    ).toEqual({
      title: "Page",
      description: "Page details",
      keywords: ["layout"],
      openGraph: { type: "article", image: "page.png" },
      twitter: { card: "summary", image: "layout.png", title: "tweet" },
    });
  });

  it("applies the nearest template once, including an own fallback, and preserves an absolute child title", () => {
    const parent = vi.fn(() => ({
      title: { default: "Parent", template: "%s | Parent" },
      description: "parent",
    })) as unknown as PageMetadata<PipelineLoader>;
    expect(
      resolve({
        metadata: { title: "Page" },
        data: {},
        ancestors: [
          { kind: "root", metadata: { title: { template: "%s | Root" } }, data: {} },
          { kind: "layout", metadata: { title: { template: "%s | Layout" } }, data: {} },
        ],
      }).metadata?.title,
    ).toBe("Page | Layout");
    expect(
      resolve({
        metadata: undefined,
        data: {},
        ancestors: [{ kind: "root", metadata: parent, data: {} }],
      }).metadata?.title,
    ).toBe("Parent");
    expect(
      resolve({
        metadata: { title: { absolute: "Canonical" } },
        data: {},
        ancestors: [{ kind: "root", metadata: parent, data: {} }],
      }).metadata,
    ).toEqual({ title: "Canonical", description: "parent" });
    expect(parent).toHaveBeenCalled();
  });

  it("lets callback titles replace non-absolute descendants without reapplying an already handled title", () => {
    expect(
      resolve({
        metadata: { title: "Child" },
        data: {},
        ancestors: [
          {
            kind: "layout",
            data: {},
            metadata: () => ({ title: { absolute: "Override" } }),
          },
        ],
      }).metadata?.title,
    ).toBe("Override");

    const ancestorChain = (title: string) =>
      resolve({
        metadata: { title: "Child" },
        data: {},
        ancestors: [
          { kind: "root", data: {}, metadata: { title: { template: "%s | Root" } } },
          { kind: "layout", data: {}, metadata: () => ({ title }) },
          { kind: "layout", data: {}, metadata: { title: { template: "%s | Inner" } } },
        ],
      }).metadata?.title;

    expect(ancestorChain("Child | Inner")).toBe("Child | Inner");
    expect(ancestorChain("Override")).toBe("Override | Root");
  });

  it("keeps a descendant title over a static ancestor absolute title", () => {
    expect(
      resolve({
        metadata: { title: "Child" },
        data: {},
        ancestors: [{ kind: "root", data: {}, metadata: { title: { absolute: "Root" } } }],
      }).metadata?.title,
    ).toBe("Child");
  });

  it("marks a callback's own default/template fallback as handled", () => {
    expect(
      resolve({
        metadata: () => ({ title: { default: "Fallback", template: "%s | Page" } }),
        data: {},
        ancestors: [{ kind: "root", data: {}, metadata: { title: { template: "%s | Root" } } }],
      }).metadata?.title,
    ).toBe("Fallback");
  });

  it("skips all callbacks for failed loaders and attributes ancestor throws, including undefined", () => {
    const page = vi.fn(() => ({ title: "never" })) as unknown as PageMetadata<PipelineLoader>;
    const ancestor = vi.fn(() => ({ title: "never" })) as unknown as PageMetadata<PipelineLoader>;
    expect(
      resolve({
        metadata: page,
        data: {},
        failed: true,
        ancestors: [{ kind: "layout", metadata: ancestor, data: {} }],
      }),
    ).toEqual({ metadata: ERROR_PAGE_METADATA });
    expect(page).not.toHaveBeenCalled();
    expect(ancestor).not.toHaveBeenCalled();
    const throwsUndefined = (() => {
      throw undefined;
    }) as unknown as PageMetadata<PipelineLoader>;
    expect(
      resolve({
        metadata: { title: "Page" },
        data: {},
        ancestors: [{ kind: "root", metadata: throwsUndefined, data: {} }],
      }),
    ).toMatchObject({ metadata: ERROR_PAGE_METADATA, thrown: undefined, throwingLevel: "app" });
  });

  it("keeps the legacy undefined result when nothing declared metadata", () => {
    expect(resolve().metadata).toBeUndefined();
  });

  it("keeps translated titles request-scoped across distinct shared localization snapshots", () => {
    type TranslatorShared = Readonly<SharedContext> & {
      readonly translate: (key: string) => string;
    };
    const english = { translate: (key: string) => `en:${key}` } as TranslatorShared;
    const arabic = { translate: (key: string) => `ar:${key}` } as TranslatorShared;
    const page = vi.fn(({ shared: requestShared }: MetadataContext<unknown>): MetadataInput => ({
      title: (requestShared as TranslatorShared).translate("page"),
    }));
    const root = vi.fn(
      ({ shared: requestShared, child }: MetadataContext<unknown>): MetadataInput => ({
        ...child?.metadata,
        description: `${(requestShared as TranslatorShared).translate("site")} ${child?.metadata.title}`,
      }),
    );

    const first = resolve({
      metadata: page,
      data: {},
      shared: english,
      ancestors: [{ kind: "root", metadata: root, data: {} }],
    });
    const second = resolve({
      metadata: page,
      data: {},
      shared: arabic,
      ancestors: [{ kind: "root", metadata: root, data: {} }],
    });

    expect(first.metadata).toMatchObject({ title: "en:page", description: "en:site en:page" });
    expect(second.metadata).toMatchObject({ title: "ar:page", description: "ar:site ar:page" });
    expect(first.metadata?.description).not.toBe(second.metadata?.description);
    expect(page.mock.calls.map(([context]) => context.shared)).toEqual([english, arabic]);
    expect(root.mock.calls.map(([context]) => context.shared)).toEqual([english, arabic]);
  });

  it("uses callback output as the level result unless the callback explicitly retains child fields", () => {
    const result = resolve({
      metadata: { title: "Page", description: "page", openGraph: { image: "page.png" } },
      data: {},
      ancestors: [
        {
          kind: "layout",
          data: {},
          metadata: ({ child }) => ({
            title: `${child?.metadata.title} | Site`,
            description: "override",
          }),
        },
      ],
    });
    expect(result.metadata).toEqual({ title: "Page | Site", description: "override" });
  });
});
