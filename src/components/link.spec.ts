import type { MouseEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectNavigator, type Navigator } from "../routing/navigator";
import { publishRouteTable, resetRouteTable } from "../routing/route-table";
import {
  AmbiguousLinkDestinationError,
  Link,
  MissingLinkDestinationError,
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

  it("bypasses the navigator for an explicit target=\"_blank\" too", () => {
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
    expect(render({ to: "main.home", component: "button" }).props).not.toHaveProperty(
      "component",
    );
  });
});
