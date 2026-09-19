import type { FocusEvent, MouseEvent } from "react";
import { requestContext } from "@warlock.js/core";
import { stringify } from "devalue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPrefetchCache, takePrefetchedPageData } from "../client/navigation/prefetch";
import { connectSharedStore } from "../shared";
import { recordCurrentLocale, resetCurrentLocale } from "../routing/current-locale";
import { publishLocaleRouting } from "../routing/locale-routing";
import { connectNavigator, type Navigator } from "../routing/navigator";
import { publishRouteTable, resetRouteTable } from "../routing/route-table";
import {
  AmbiguousLinkDestinationError,
  Link,
  MissingLinkDestinationError,
  RouteArgumentsOnLiteralUrlError,
  RouteNameShapeCollisionError,
  type LinkProps,
} from "./link";

/**
 * The suite runs in `node`, so there is no DOM to click. `<Link>` uses no
 * hooks, so it is called as the plain function it is and asserted on as the
 * element it returns — the same shape `hydrate-page.spec.ts` uses. What is
 * under test is which URL lands on the element and WHO handles the click, and
 * both are visible in the returned props without a renderer.
 */

type RenderedProps = Record<string, unknown>;

function render(props: LinkProps): { type: unknown; props: RenderedProps } {
  const element = Link(props);

  return { type: element.type, props: element.props as RenderedProps };
}

type FakeClick = {
  event: MouseEvent<HTMLAnchorElement>;
  preventDefault: ReturnType<typeof vi.fn>;
};

/** A plain left click: the ONLY click that means "go there in this tab". */
function plainLeftClick(): FakeClick {
  const preventDefault = vi.fn();

  const event = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault,
  } as unknown as MouseEvent<HTMLAnchorElement>;

  return { event, preventDefault };
}

function clickOn(rendered: { props: RenderedProps }): FakeClick {
  const click = plainLeftClick();
  const onClick = rendered.props.onClick as (event: MouseEvent<HTMLAnchorElement>) => void;

  onClick(click.event);

  return click;
}

let navigate: ReturnType<typeof vi.fn<Navigator>>;

beforeEach(() => {
  publishRouteTable(
    [
      { name: "main.home", path: "/" },
      { name: "products.details", path: "/products/:id" },
    ],
    "link.spec",
  );

  navigate = vi.fn<Navigator>(() => true);
  connectNavigator(navigate);
});

afterEach(() => {
  connectNavigator(undefined);
  resetRouteTable();
  resetCurrentLocale();
  publishLocaleRouting({ strategy: "none", codes: [], defaultLocale: "" });
});

describe("Link — the existing route-name surface", () => {
  it("resolves `to` with `params` and `query` through the route table", () => {
    const { type, props } = render({
      to: "products.details",
      params: { id: 7 },
      query: { ref: "email" },
    });

    expect(type).toBe("a");
    expect(props.href).toBe("/products/7?ref=email");
  });

  it("hands a plain left click to the navigator and suppresses the browser", () => {
    const rendered = render({ to: "main.home" });
    const { preventDefault } = clickOn(rendered);

    expect(navigate).toHaveBeenCalledWith("/");
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});

describe("Link — `href` as an alias of `to`", () => {
  it("resolves a route NAME exactly as `to` does", () => {
    expect(render({ href: "products.details", params: { id: 7 } }).props.href).toBe(
      render({ to: "products.details", params: { id: 7 } }).props.href,
    );
  });

  it("navigates in-app, because it is the same destination `to` names", () => {
    clickOn(render({ href: "main.home" }));

    expect(navigate).toHaveBeenCalledWith("/");
  });
});

describe("Link — exactly one destination", () => {
  /*
    The decision this file ratifies: two destinations is a REFUSAL, not a
    precedence. A precedence rule ("`to` wins") is silent — the losing prop
    keeps compiling, keeps reading like it works at the call site, and renders
    a link to the wrong page. The type refuses the pair (the `@ts-expect-error`
    lines below fail `typecheck` if it ever stops refusing) and the runtime
    refuses it too, because a JS caller and a cast both get past the type.
  */

  it("refuses `to` and `href` together", () => {
    expect(() =>
      // @ts-expect-error two destinations is a compile-time error, asserted here
      render({ to: "main.home", href: "products.details" }),
    ).toThrow(AmbiguousLinkDestinationError);
  });

  it("names both offending props in the message", () => {
    // @ts-expect-error two destinations is a compile-time error, asserted here
    expect(() => render({ to: "main.home", email: "sales@example.com" })).toThrow(
      /"email".*"to"|"to".*"email"/,
    );
  });

  it("refuses a link with no destination at all", () => {
    // @ts-expect-error a destination is required, asserted here
    expect(() => render({ children: "nowhere" })).toThrow(MissingLinkDestinationError);
  });
});

describe("Link — `email` and `tel` are not in-app navigations", () => {
  it("renders `email` as a mailto: URL", () => {
    expect(render({ email: "sales@example.com" }).props.href).toBe("mailto:sales@example.com");
  });

  it("renders `tel` as a tel: URL", () => {
    expect(render({ tel: "+201000000000" }).props.href).toBe("tel:+201000000000");
  });

  it("never asks the navigator about a mailto:, and never prevents the default", () => {
    const { preventDefault } = clickOn(render({ email: "sales@example.com" }));

    expect(navigate).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("never asks the navigator about a tel:, and never prevents the default", () => {
    const { preventDefault } = clickOn(render({ tel: "+201000000000" }));

    expect(navigate).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("still runs the caller's own onClick", () => {
    const onClick = vi.fn();

    clickOn(render({ email: "sales@example.com", onClick }));

    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("Link — `newTab`", () => {
  it("opens in a new browsing context, safely", () => {
    const { props } = render({ to: "main.home", newTab: true });

    expect(props.target).toBe("_blank");
    expect(props.rel).toBe("noopener noreferrer");
  });

  it("does not leak `newTab` onto the element as an attribute", () => {
    expect(render({ to: "main.home", newTab: true }).props).not.toHaveProperty("newTab");
  });

  it("leaves a caller's explicit `target` and `rel` alone", () => {
    const { props } = render({
      to: "main.home",
      newTab: true,
      target: "_self",
      rel: "me",
    });

    expect(props.target).toBe("_self");
    expect(props.rel).toBe("me");
  });

  it("never asks the navigator, and never prevents the default", () => {
    const { preventDefault } = clickOn(render({ to: "main.home", newTab: true }));

    expect(navigate).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('bypasses the navigator for an explicit target="_blank" too', () => {
    const { preventDefault } = clickOn(render({ to: "main.home", target: "_blank" }));

    expect(navigate).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe("Link — `component`", () => {
  it("renders the given tag instead of an anchor, with the resolved URL", () => {
    const { type, props } = render({ to: "main.home", component: "button" });

    expect(type).toBe("button");
    expect(props.href).toBe("/");
  });

  it("renders a component and keeps click delegation on it", () => {
    const Fancy = (): null => null;

    const rendered = render({ to: "main.home", component: Fancy });

    expect(rendered.type).toBe(Fancy);

    clickOn(rendered);

    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("does not leak `component` onto the element as a prop", () => {
    expect(render({ to: "main.home", component: "button" }).props).not.toHaveProperty("component");
  });
});

describe("Link — literal URLs and paths", () => {
  /*
    The owner ruling of 2026-08-24: a destination is discriminated by SHAPE. It
    begins with `/` or carries a scheme, and it is a literal URL passed through
    untouched; anything else is a route NAME. This is what makes `@mongez/react-
    router` code portable — MRR's `to` is a PATH, ours is a NAME, and after this
    both compile and both mean what they say.
  */

  it("passes an https: URL through untouched", () => {
    expect(render({ href: "https://stripe.com/pricing?x=1" }).props.href).toBe(
      "https://stripe.com/pricing?x=1",
    );
  });

  it("passes an http: URL through untouched", () => {
    expect(render({ to: "http://example.com" }).props.href).toBe("http://example.com");
  });

  it("passes an absolute path through untouched", () => {
    expect(render({ href: "/absolute/path?page=2#top" }).props.href).toBe(
      "/absolute/path?page=2#top",
    );
  });

  it("passes a mailto: destination through untouched", () => {
    expect(render({ href: "mailto:sales@example.com" }).props.href).toBe(
      "mailto:sales@example.com",
    );
  });

  it("passes any other scheme through untouched", () => {
    expect(render({ href: "tel:+201000000000" }).props.href).toBe("tel:+201000000000");
    expect(render({ href: "whatsapp://send?phone=1" }).props.href).toBe("whatsapp://send?phone=1");
  });

  it("still resolves a bare route NAME through the route table", () => {
    expect(render({ to: "products.details", params: { id: 7 } }).props.href).toBe("/products/7");
  });

  /*
    The load-bearing assertion. `href()` THROWS when no table is published, so a
    literal URL that renders with the table torn down proves the lookup never
    happened — no spy, no mock, no way for the proof to drift from the code.
  */
  it("never touches the route table for a literal URL", () => {
    resetRouteTable();

    expect(render({ href: "https://stripe.com" }).props.href).toBe("https://stripe.com");
    expect(render({ href: "/pricing" }).props.href).toBe("/pricing");
    expect(render({ href: "mailto:sales@example.com" }).props.href).toBe(
      "mailto:sales@example.com",
    );
  });

  it("does not client-navigate to an external URL", () => {
    const { preventDefault } = clickOn(render({ href: "https://stripe.com" }));

    expect(navigate).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("client-navigates an absolute path, which is a page in this app", () => {
    const { preventDefault } = clickOn(render({ href: "/pricing" }));

    expect(navigate).toHaveBeenCalledWith("/pricing");
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("treats a protocol-relative URL as external", () => {
    const rendered = render({ href: "//cdn.example.com/asset" });

    expect(rendered.props.href).toBe("//cdn.example.com/asset");

    clickOn(rendered);

    expect(navigate).not.toHaveBeenCalled();
  });

  it("refuses `params` or `query` alongside a literal URL", () => {
    expect(() => render({ href: "/pricing", query: { page: 2 } })).toThrow(
      RouteArgumentsOnLiteralUrlError,
    );

    expect(() => render({ href: "https://stripe.com", params: { id: 1 } })).toThrow(
      RouteArgumentsOnLiteralUrlError,
    );
  });

  it("refuses a route table that names a route the way a URL is shaped", () => {
    publishRouteTable([{ name: "/pricing", path: "/plans" }], "link.spec");

    expect(() => render({ href: "/pricing" })).toThrow(RouteNameShapeCollisionError);
  });
});

describe("Link — locale routing (design note §B.2)", () => {
  /*
    This suite runs in `node` (see the file header), so `typeof window ===
    "undefined"` and `readCurrentLocale()` always takes the SERVER branch —
    the per-request ALS store, never `recordCurrentLocale`'s browser-only
    slot (which is a no-op here; see `routing/current-locale.ts`'s header
    for why). `withLocale` opens that same per-request context the way a
    real request would, via `requestContext.run()`.
  */
  beforeEach(() => {
    connectSharedStore(() => requestContext.getStore());
  });

  afterEach(() => {
    connectSharedStore(undefined);
  });

  function withLocale<T>(locale: string, fn: () => T): T {
    // `Context.run`'s type expects an async callback (`() => Promise<T>`),
    // but `AsyncLocalStorage.run` at runtime just calls `fn()` and returns
    // whatever it gets back — a synchronous callback works exactly the same
    // as it would called directly, ALS scope and all. Cast rather than
    // wrapping `fn` in a real `async () => fn()`, which would make every
    // call site `await`, including the synchronous ones below.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return requestContext.run(
      { request: { locale }, response: {} } as any,
      fn as unknown as () => Promise<T>,
    ) as unknown as T;
  }

  it("prefixes a route-name destination with the active non-default locale", () => {
    publishLocaleRouting({
      strategy: "prefix-except-default",
      codes: ["en", "ar"],
      defaultLocale: "en",
    });

    const href = withLocale(
      "ar",
      () => render({ to: "products.details", params: { id: 7 } }).props.href,
    );

    expect(href).toBe("/ar/products/7");
  });

  it("skips the prefix for the default locale under prefix-except-default", () => {
    publishLocaleRouting({
      strategy: "prefix-except-default",
      codes: ["en", "ar"],
      defaultLocale: "en",
    });

    const href = withLocale(
      "en",
      () => render({ to: "products.details", params: { id: 7 } }).props.href,
    );

    expect(href).toBe("/products/7");
  });

  it("prefixes a literal in-app URL the same way", () => {
    publishLocaleRouting({ strategy: "prefix", codes: ["en", "ar"], defaultLocale: "en" });

    const href = withLocale("ar", () => render({ href: "/pricing" }).props.href);

    expect(href).toBe("/ar/pricing");
  });

  it("does not double-prefix a literal URL that already begins with a routed code", () => {
    publishLocaleRouting({ strategy: "prefix", codes: ["en", "ar"], defaultLocale: "en" });

    withLocale("ar", () => {
      expect(render({ href: "/ar/pricing" }).props.href).toBe("/ar/pricing");
      // Not the active locale, but still a routed code — still not prefixed.
      expect(render({ href: "/en/pricing" }).props.href).toBe("/en/pricing");
    });
  });

  it("never prefixes an external URL or a mailto:", () => {
    publishLocaleRouting({ strategy: "prefix", codes: ["en", "ar"], defaultLocale: "en" });

    withLocale("ar", () => {
      expect(render({ href: "https://stripe.com/pricing" }).props.href).toBe(
        "https://stripe.com/pricing",
      );
      expect(render({ email: "sales@example.com" }).props.href).toBe("mailto:sales@example.com");
    });
  });

  it("leaves every URL untouched under strategy none, the innocent case", () => {
    publishLocaleRouting({ strategy: "none", codes: [], defaultLocale: "" });

    withLocale("ar", () => {
      expect(render({ to: "products.details", params: { id: 7 } }).props.href).toBe("/products/7");
      expect(render({ href: "/pricing" }).props.href).toBe("/pricing");
    });
  });

  it("leaves every URL untouched when no request context is open", () => {
    publishLocaleRouting({
      strategy: "prefix-except-default",
      codes: ["en", "ar"],
      defaultLocale: "en",
    });
    // No `withLocale` — no `LocaleProvider`, and on the server no open request either.

    expect(render({ to: "products.details", params: { id: 7 } }).props.href).toBe("/products/7");
  });

  it("recordCurrentLocale (the browser seam) is a no-op here, on the server", () => {
    publishLocaleRouting({
      strategy: "prefix-except-default",
      codes: ["en", "ar"],
      defaultLocale: "en",
    });
    recordCurrentLocale("ar");

    expect(render({ to: "products.details", params: { id: 7 } }).props.href).toBe("/products/7");
  });
});

describe("Link — [locale] folder routing (design note §C.2)", () => {
  /*
    Same server-branch reasoning as the §B.2 suite above (see its own header):
    this runs in `node`, so `readCurrentLocale()` reads the per-request ALS
    store via `withLocale`, never the browser-only slot.
  */
  beforeEach(() => {
    connectSharedStore(() => requestContext.getStore());
    publishRouteTable(
      [
        { name: "main.home", path: "/" },
        { name: "products.details", path: "/products/:id" },
        { name: "posts.show", path: "/:locale/posts/:slug" },
        { name: "posts.deep", path: "/posts/:locale" },
      ],
      "link.spec",
    );
  });

  afterEach(() => {
    connectSharedStore(undefined);
  });

  function withLocale<T>(locale: string, fn: () => T): T {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return requestContext.run(
      { request: { locale }, response: {} } as any,
      fn as unknown as () => Promise<T>,
    ) as unknown as T;
  }

  it("fills a missing leading :locale param with the current locale", () => {
    const href = withLocale(
      "en",
      () => render({ to: "posts.show", params: { slug: "hello" } }).props.href,
    );

    expect(href).toBe("/en/posts/hello");
  });

  it("lets an explicit locale param win over the current locale", () => {
    const href = withLocale(
      "en",
      () => render({ to: "posts.show", params: { slug: "hello", locale: "ar" } }).props.href,
    );

    expect(href).toBe("/ar/posts/hello");
  });

  it("does not fill a :locale that is not the first segment", () => {
    withLocale("en", () => {
      expect(() => render({ to: "posts.deep" })).toThrow();
    });
  });

  it("leaves the link unfilled when no current locale is known", () => {
    // No `withLocale` — no request context open on the server.
    expect(() => render({ to: "posts.show", params: { slug: "hello" } })).toThrow();
  });

  it("does not touch a route with no :locale param at all", () => {
    const href = withLocale(
      "en",
      () => render({ to: "products.details", params: { id: 7 } }).props.href,
    );

    expect(href).toBe("/products/7");
  });
});

describe("Link — locale routing never leaks across concurrent SSR requests", () => {
  /*
    THE CASE the coordinator flagged: `typeof window === "undefined"` in this
    suite (it runs in `node`), so `readCurrentLocale()` takes the SERVER
    branch — `currentRequestLocale()` (`../shared.ts`), resolved off the
    per-request `AsyncLocalStorage` store `requestContext` owns — never a
    process-wide slot. Two "requests" are opened with `requestContext.run()`,
    each carrying its own locale, and interleaved across a real `await` gap
    (the shorter delay resolves first, while the longer one is still
    pending) — exactly the interleave Stage 2 streaming SSR produces between
    two Suspense-boundary resumes of two different requests.
  */
  beforeEach(() => {
    publishLocaleRouting({
      strategy: "prefix-except-default",
      codes: ["en", "ar"],
      defaultLocale: "en",
    });
    connectSharedStore(() => requestContext.getStore());
  });

  afterEach(() => {
    connectSharedStore(undefined);
  });

  async function renderFor(locale: string, delayMs: number): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return requestContext.run({ request: { locale }, response: {} } as any, async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      return render({ to: "products.details", params: { id: 7 } }).props.href as string;
    });
  }

  it("renders each request's <Link> with ITS OWN locale, not the other request's", async () => {
    // "ar" resolves FIRST (0ms) while "en" (20ms) is still suspended.
    const [en, ar] = await Promise.all([renderFor("en", 20), renderFor("ar", 0)]);

    expect(en).toBe("/products/7");
    expect(ar).toBe("/ar/products/7");
  });

  it("holds under the reverse interleave too", async () => {
    const [ar, en] = await Promise.all([renderFor("ar", 20), renderFor("en", 0)]);

    expect(ar).toBe("/ar/products/7");
    expect(en).toBe("/products/7");
  });
});

describe("Link — prefetch", () => {
  // This fixture carries all seven REQUIRED_PAYLOAD_KEYS on purpose. Navigation
  // validates through the one shared `isHydrationPayload` gate, and a payload
  // missing any required key is classified `hard-navigate` and never cached —
  // at which point every assertion below that a prefetch landed fails for a
  // reason that has nothing to do with `<Link>`.
  const PAYLOAD = {
    name: "main.home",
    locale: "en",
    appData: {},
    layoutData: {},
    pageData: {},
    shared: {},
    translations: {},
  };

  function respondWithPayload(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      url: "",
      // devalue is the page-data wire format: `fetchPageData` reads `.text()`
      // and decodes it with devalue's `parse`, never `.json()`.
      text: async () => stringify(PAYLOAD),
    }));

    vi.stubGlobal("fetch", fetchMock);

    return fetchMock as unknown as ReturnType<typeof vi.fn>;
  }

  /** The suite runs in `node`; prefetch refuses to run without a browser. */
  beforeEach(() => {
    vi.stubGlobal("window", {});
    resetPrefetchCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetPrefetchCache();
    vi.restoreAllMocks();
  });

  /** Lets every pending microtask of the speculative fetch settle. */
  function flush(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  async function hover(rendered: { props: RenderedProps }): Promise<void> {
    const onMouseEnter = rendered.props.onMouseEnter as
      ((event: MouseEvent<HTMLAnchorElement>) => void) | undefined;

    onMouseEnter?.({} as MouseEvent<HTMLAnchorElement>);

    await flush();
  }

  it("populates the cache on hover", async () => {
    respondWithPayload();

    await hover(render({ to: "main.home", prefetch: true }));

    expect(takePrefetchedPageData("/")).toEqual({ type: "payload", payload: PAYLOAD, url: "/" });
  });

  it("populates the cache on focus, for keyboard navigation", async () => {
    respondWithPayload();

    const { props } = render({ to: "products.details", params: { id: 7 }, prefetch: true });
    const onFocus = props.onFocus as (event: FocusEvent<HTMLAnchorElement>) => void;

    onFocus({} as FocusEvent<HTMLAnchorElement>);

    await flush();

    expect(takePrefetchedPageData("/products/7")).toBeDefined();
  });

  it("still runs the caller's own onMouseEnter", async () => {
    respondWithPayload();

    const onMouseEnter = vi.fn();

    await hover(render({ to: "main.home", prefetch: true, onMouseEnter }));

    expect(onMouseEnter).toHaveBeenCalledOnce();
  });

  it("does not touch the network without the prop", async () => {
    const fetchMock = respondWithPayload();

    await hover(render({ to: "main.home" }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not leak `prefetch` onto the element as an attribute", () => {
    expect(render({ to: "main.home", prefetch: true }).props).not.toHaveProperty("prefetch");
  });

  const NEVER_PREFETCHED: readonly [string, LinkProps][] = [
    ["an external URL", { href: "https://stripe.com", prefetch: true }],
    ["a mailto:", { email: "sales@example.com", prefetch: true }],
    ["a tel:", { tel: "+201000000000", prefetch: true }],
    ["a protocol-relative URL", { href: "//cdn.example.com/asset", prefetch: true }],
    ["a newTab link", { to: "main.home", newTab: true, prefetch: true }],
    ["an explicit target", { to: "main.home", target: "_blank", prefetch: true }],
  ];

  it.each(NEVER_PREFETCHED)("never prefetches %s", async (_case, props) => {
    const fetchMock = respondWithPayload();

    await hover(render(props));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is silent when the prefetch fails, and the click still navigates", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    const rendered = render({ to: "main.home", prefetch: true });

    await expect(hover(rendered)).resolves.toBeUndefined();

    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(takePrefetchedPageData("/")).toBeUndefined();

    const { preventDefault } = clickOn(rendered);

    expect(navigate).toHaveBeenCalledWith("/");
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
