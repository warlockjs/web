import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  MissingHydrationErrorPageError,
  UnknownHydrationPageNameError,
  buildHydratedTree,
} from "./build-hydrated-tree";
import type { ClientPageEntry, ClientRouteComposition } from "./runtime/types";
import type {
  HydrationDocumentPayloadSource,
  SerializedErrorPageProps,
} from "../hydration-payload";

type LevelProps = { data: unknown; shared: unknown; children?: ReactNode };

const Page = (_props: LevelProps): null => null;
const OuterLayout = (_props: LevelProps): null => null;
const InnerLayout = (_props: LevelProps): null => null;
const App = (_props: LevelProps): null => null;
const ErrorPage = (_props: SerializedErrorPageProps): null => null;

/** A module NAMESPACE, which is what the registry's `load()` resolves to. */
const moduleOf = (component: unknown) => ({ default: component });

function payloadFor(name: string): HydrationDocumentPayloadSource {
  return {
    name,
    appData: { level: "app" },
    layoutData: { level: "layout" },
    pageData: { level: "page" },
    shared: { locale: "en" },
  };
}

function errorPayloadFor(name: string): HydrationDocumentPayloadSource {
  return {
    ...payloadFor(name),
    errorPage: {
      error: { name: "Error", message: "page exploded", stack: "Error: page exploded" },
      status: 503,
    },
  };
}

function entry(
  name: string,
  load: () => ClientRouteComposition | Promise<ClientRouteComposition>,
): ClientPageEntry {
  return { type: "page", name, path: `/${name}`, load };
}

/** Narrow a ReactNode to an element so props can be read without `any`. */
function asElement<Props extends object = LevelProps>(node: ReactNode): ReactElement<Props> {
  if (!isValidElement(node)) {
    throw new Error(`Expected a React element, received ${String(node)}.`);
  }

  return node as ReactElement<Props>;
}

/**
 * The composed structure, outermost first — the rendered tree itself, not a
 * string of it, so an assertion cannot pass on a coincidental substring.
 */
function levelTypesOf(node: ReactNode): unknown[] {
  const types: unknown[] = [];

  for (let current = node; isValidElement(current); ) {
    const element = current as ReactElement<LevelProps>;
    types.push(element.type);
    current = element.props.children as ReactNode;
  }

  return types;
}

describe("buildHydratedTree", () => {
  it("composes ordered layouts -> Page, outermost first, with the payload's props", async () => {
    const pages = [
      entry("main.home", () => ({
        Page: moduleOf(Page),
        layouts: [moduleOf(OuterLayout), moduleOf(InnerLayout)],
        App: moduleOf(App),
      })),
    ];
    const payload = payloadFor("main.home");

    const outer = asElement(await buildHydratedTree(pages, payload));
    expect(outer.type).toBe(OuterLayout);
    expect(outer.props.data).toBe(payload.layoutData);
    expect(outer.props.shared).toBe(payload.shared);

    const inner = asElement(outer.props.children);
    expect(inner.type).toBe(InnerLayout);
    expect(inner.props.data).toBe(payload.layoutData);

    const page = asElement(inner.props.children);
    expect(page.type).toBe(Page);
    expect(page.props.data).toBe(payload.pageData);
    expect(page.props.shared).toBe(payload.shared);
    expect(page.props.children).toBeUndefined();
  });

  it("hydrates the server-selected ErrorPage instead of the ordinary Page", async () => {
    const pages = [
      entry("main.home", () => ({
        Page: moduleOf(Page),
        ErrorPage: moduleOf(ErrorPage),
        layouts: [moduleOf(OuterLayout), moduleOf(InnerLayout)],
        App: moduleOf(App),
      })),
    ];
    const payload = errorPayloadFor("main.home");

    const outer = asElement(await buildHydratedTree(pages, payload));
    const inner = asElement(outer.props.children);
    const errorPage = asElement<SerializedErrorPageProps>(inner.props.children);

    expect(levelTypesOf(outer)).toEqual([OuterLayout, InnerLayout, ErrorPage]);
    expect(errorPage.type).toBe(ErrorPage);
    expect(errorPage.props).toEqual(payload.errorPage);
    expect(levelTypesOf(outer)).not.toContain(Page);
  });

  it("fails closed when the server selected an error page absent from the client graph", async () => {
    const pages = [
      entry("main.home", () => ({ Page: moduleOf(Page), layouts: [] })),
    ];

    await expect(
      buildHydratedTree(pages, errorPayloadFor("main.home")),
    ).rejects.toBeInstanceOf(MissingHydrationErrorPageError);
  });

  /**
   * The App level renders `<html>`/`<body>` and the `<div id="root">` this tree
   * is mounted INTO, so it is never part of the markup inside `#root`.
   * Composing it here would hydrate a document the server never put there.
   */
  it("excludes App from the tree even when the composition carries one", async () => {
    const pages = [
      entry("main.home", () => ({
        Page: moduleOf(Page),
        layouts: [moduleOf(OuterLayout), moduleOf(InnerLayout)],
        App: moduleOf(App),
      })),
    ];

    const tree = await buildHydratedTree(pages, payloadFor("main.home"));

    expect(levelTypesOf(tree)).toEqual([OuterLayout, InnerLayout, Page]);
    expect(levelTypesOf(tree)).not.toContain(App);
    expect(asElement(tree).type).toBe(OuterLayout);
  });

  it("looks the entry up by name rather than by position or path", async () => {
    const pages = [
      entry("main.home", () => ({ Page: moduleOf(OuterLayout), layouts: [] })),
      entry("main.about", () => ({ Page: moduleOf(Page), layouts: [] })),
    ];

    const page = asElement(await buildHydratedTree(pages, payloadFor("main.about")));

    expect(page.type).toBe(Page);
  });

  it("mounts the page alone when the route has no layouts", async () => {
    const pages = [
      entry("main.home", () => ({ Page: moduleOf(Page), layouts: [], App: moduleOf(App) })),
    ];

    const page = asElement(await buildHydratedTree(pages, payloadFor("main.home")));

    expect(page.type).toBe(Page);
    expect(page.props.children).toBeUndefined();
  });

  it("composes the layouts and page when the composition carries no App", async () => {
    const pages = [
      entry("main.home", () => ({ Page: moduleOf(Page), layouts: [moduleOf(OuterLayout)] })),
    ];

    const outer = asElement(await buildHydratedTree(pages, payloadFor("main.home")));

    expect(outer.type).toBe(OuterLayout);
    expect(asElement(outer.props.children).type).toBe(Page);
  });

  it("treats a level with no default export as a passthrough, as the server does", async () => {
    const pages = [
      entry("main.home", () => ({
        Page: moduleOf(Page),
        layouts: [{ route: "/" }],
        App: {},
      })),
    ];

    const page = asElement(await buildHydratedTree(pages, payloadFor("main.home")));

    expect(page.type).toBe(Page);
  });

  it("fails closed on an unknown name, naming it and listing the registry's names", async () => {
    const pages = [
      entry("main.home", () => ({ Page: moduleOf(Page), layouts: [] })),
      entry("main.about", () => ({ Page: moduleOf(Page), layouts: [] })),
    ];

    const failure = await buildHydratedTree(pages, payloadFor("main.contact")).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(UnknownHydrationPageNameError);
    const error = failure as UnknownHydrationPageNameError;
    expect(error.name).toBe("UnknownHydrationPageNameError");
    expect(error.pageName).toBe("main.contact");
    expect(error.knownPageNames).toEqual(["main.home", "main.about"]);
    expect(error.message).toContain('"main.contact"');
    expect(error.message).toContain('"main.home"');
    expect(error.message).toContain('"main.about"');
  });

  it("says the registry is empty rather than listing nothing", async () => {
    const failure = await buildHydratedTree([], payloadFor("main.home")).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect((failure as Error).message).toContain("registry is empty");
  });

  it("never substitutes another entry for an unknown name", async () => {
    const load = vi.fn(() => ({ Page: moduleOf(Page), layouts: [] }));

    await expect(
      buildHydratedTree([entry("main.home", load)], payloadFor("main.ghost")),
    ).rejects.toBeInstanceOf(UnknownHydrationPageNameError);

    expect(load).not.toHaveBeenCalled();
  });

  it("propagates a rejected load rather than mounting something else", async () => {
    const boom = new Error("chunk 404");
    const pages = [entry("main.home", () => Promise.reject(boom))];

    await expect(buildHydratedTree(pages, payloadFor("main.home"))).rejects.toBe(boom);
  });

  it("rejects a load that resolves to a malformed composition", async () => {
    const pages = [entry("main.home", () => ({ layouts: [] }) as unknown as ClientRouteComposition)];

    await expect(buildHydratedTree(pages, payloadFor("main.home"))).rejects.toThrow(TypeError);
  });

  it("invokes load once per hydration, not once per layout", async () => {
    const load = vi.fn(() => ({
      Page: moduleOf(Page),
      layouts: [moduleOf(OuterLayout), moduleOf(InnerLayout)],
      App: moduleOf(App),
    }));

    await buildHydratedTree([entry("main.home", load)], payloadFor("main.home"));

    expect(load).toHaveBeenCalledTimes(1);
  });

  it("registers real namespaces rootward-to-leaf before extracting components", async () => {
    const events: string[] = [];
    const registeredModule = (name: string, component: unknown) => ({
      register: () => events.push(`register:${name}`),
      get default() {
        events.push(`component:${name}`);
        return component;
      },
    });
    const app = registeredModule("app", App);
    const outer = registeredModule("outer", OuterLayout);
    const inner = registeredModule("inner", InnerLayout);
    const page = registeredModule("page", Page);
    const load = vi.fn(() => ({ Page: page, layouts: [outer, inner], App: app }));

    await buildHydratedTree([entry("main.home", load)], payloadFor("main.home"));

    expect(events).toEqual([
      "register:app",
      "register:outer",
      "register:inner",
      "register:page",
      "component:page",
      "component:inner",
      "component:outer",
    ]);
  });

  it("registers the selected error leaf instead of the ordinary page", async () => {
    const events: string[] = [];
    const registeredModule = (name: string, component: unknown) => ({
      register: () => events.push(`register:${name}`),
      get default() {
        events.push(`component:${name}`);
        return component;
      },
    });
    const app = registeredModule("app", App);
    const layout = registeredModule("layout", OuterLayout);
    const page = registeredModule("page", Page);
    const errorPage = registeredModule("error", ErrorPage);
    const pages = [
      entry("main.home", () => ({
        Page: page,
        ErrorPage: errorPage,
        layouts: [layout],
        App: app,
      })),
    ];

    await buildHydratedTree(pages, errorPayloadFor("main.home"));

    expect(events).toEqual([
      "register:app",
      "register:layout",
      "register:error",
      "component:error",
      "component:layout",
    ]);
  });
});
