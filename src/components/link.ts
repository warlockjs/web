import { createElement } from "react";
import type {
  AnchorHTMLAttributes,
  ComponentType,
  MouseEvent,
  ReactElement,
} from "react";
import { currentNavigator } from "../routing/navigator";
import { href } from "../routing/route-table";

/**
 * `<Link>` is SUGAR over `href()`, and deliberately thin.
 *
 * `href(name, params, query)` is the durable primitive — it serves emails,
 * redirects, `Location` headers and every non-React caller, none of which can
 * render a component. This file adds one thing to it: an anchor element.
 *
 * It renders a real `<a href>`. Client-side interception is a later slice of
 * the navigation runtime and lands here without changing this API, which is the
 * point of routing everything through `href` first: navigation becomes a
 * BEHAVIOUR change, not an API change.
 *
 * ── Parity with `@mongez/react-router` ───────────────────────────────────────
 * `href`, `newTab`, `email`, `tel` and `component` are spelled exactly as MRR
 * spells them, so a component moved across keeps compiling. `to`, `params` and
 * `query` are ours and have no MRR equivalent: they pair with the typed `href()`
 * helper, which is what makes a route NAME — rather than a URL — the thing a
 * call site names.
 */

type AnchorProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">;

/**
 * Where the link goes. Every field is documented here once; which COMBINATIONS
 * are legal is decided by {@link LinkDestination}.
 */
type LinkDestinationProps = {
  /**
   * A route NAME, never a URL.
   *
   * A page that moves changes its URL and keeps its name, so every call site
   * survives the move. A dead name throws at render naming the routes that do
   * exist, rather than rendering an anchor that 404s.
   */
  to?: string;
  /**
   * An alias of {@link to}, for parity with `@mongez/react-router`.
   *
   * It takes a route NAME too, despite the anchor-shaped name: in this package
   * `to` is a name, and an alias that quietly meant "raw URL" would be a second
   * URL grammar wearing the first one's clothes. `params` and `query` apply to
   * it identically.
   */
  href?: string;
  /** Renders a `mailto:` link. Not an in-app navigation. */
  email?: string;
  /** Renders a `tel:` link. Not an in-app navigation. */
  tel?: string;
  /** Values for the route's `:param` segments, e.g. `{ id }` for `"/products/:id"`. */
  params?: Record<string, unknown>;
  /** Query string values; an `undefined` value is omitted. */
  query?: Record<string, unknown>;
};

/**
 * EXACTLY ONE destination, enforced by the type.
 *
 * The alternative — a documented precedence such as "`to` wins over `href`" —
 * is silent by construction: the losing prop goes on compiling and goes on
 * reading like it works at the call site, and the anchor points at the wrong
 * page. Refusing the pair costs a call site one edit and can never be
 * misread. The runtime refuses it as well, because a JavaScript caller and a
 * cast both get past this.
 */
type LinkDestination =
  | { to: string; href?: never; email?: never; tel?: never }
  | { href: string; to?: never; email?: never; tel?: never }
  | { email: string; to?: never; href?: never; tel?: never }
  | { tel: string; to?: never; href?: never; email?: never };

export type LinkProps = AnchorProps &
  LinkDestinationProps &
  LinkDestination & {
    /**
     * Open in a new browsing context: `target="_blank"` plus the `rel` that
     * stops the opened page from reaching back through `window.opener`.
     *
     * A caller's own `target`/`rel` win — this only fills in what was not said.
     */
    newTab?: boolean;
    /**
     * Render as something other than `<a>` — a tag name or a component.
     *
     * It receives the resolved `href`, the click handler and every remaining
     * prop, so a design-system anchor keeps client-side navigation as long as
     * it spreads what it is given onto the element it renders.
     *
     * `ComponentType<any>` is MRR's signature, kept verbatim: the component is
     * the caller's and its props are unknowable from here.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    component?: ComponentType<any> | string;
  };

const DESTINATION_PROPS = ["to", "href", "email", "tel"] as const;

export class AmbiguousLinkDestinationError extends Error {
  public constructor(public readonly providedProps: readonly string[]) {
    super(
      `Warlock <Link> was given ${providedProps
        .map(name => JSON.stringify(name))
        .join(" and ")}, but a link goes to exactly one place. There is no ` +
        "precedence between them on purpose: one of the two would silently win, and the " +
        "call site would go on naming a destination that never renders. Delete the one " +
        "you did not mean.",
    );
    this.name = "AmbiguousLinkDestinationError";
  }
}

export class MissingLinkDestinationError extends Error {
  public constructor() {
    super(
      `Warlock <Link> was given no destination. Pass exactly one of ${DESTINATION_PROPS.map(
        name => JSON.stringify(name),
      ).join(", ")}. It is not defaulted to the current page: an anchor with an empty ` +
        "`href` renders as a working link and reloads the page when clicked, which is a " +
        "harder fault to see than this message.",
    );
    this.name = "MissingLinkDestinationError";
  }
}

type Destination = {
  /** What lands on the element's `href`. */
  url: string;
  /**
   * Whether this URL is a page in THIS app — the only kind the client
   * navigation runtime may be asked about. `mailto:` and `tel:` hand off to
   * another application entirely, so intercepting either would break it.
   */
  isInApp: boolean;
};

function resolveDestination(props: LinkDestinationProps): Destination {
  const provided = DESTINATION_PROPS.filter(name => props[name] !== undefined);

  if (provided.length > 1) throw new AmbiguousLinkDestinationError(provided);

  if (provided.length === 0) throw new MissingLinkDestinationError();

  if (props.email !== undefined) return { url: `mailto:${props.email}`, isInApp: false };

  if (props.tel !== undefined) return { url: `tel:${props.tel}`, isInApp: false };

  /*
    Resolved against the route table published at boot from the SAME discovery
    result the server registered its routes from. The previous version of this
    file restated six URLs in a literal map, so linking to any seventh page in
    the application threw — the map was the limit on what could be linked, and
    nothing said so at the call site.
  */
  const routeName = (props.to ?? props.href) as string;

  return { url: href(routeName, props.params, props.query), isInApp: true };
}

/**
 * Whether this click should be left entirely to the browser.
 *
 * Every case here is a click that MEANS something other than "go there in this
 * tab", and intercepting any of them would take away behaviour the user
 * explicitly asked for:
 *
 *   - a modifier or middle button: open in a new tab/window, or download
 *   - `download`: save the resource, do not render it
 *   - already prevented: something upstream in the tree handled this click
 *
 * Left button with no modifiers is the only click that means plain navigation.
 * The `target` case is decided before this, from the RESOLVED target, because
 * `newTab` sets it after the caller's props are read.
 */
function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.defaultPrevented
  );
}

/**
 * A target other than `_self` names ANOTHER browsing context — `_blank`, but
 * also `_parent`, `_top` and any named frame. Client navigation rewrites the
 * history of THIS one, so none of them are ours to intercept.
 */
function opensAnotherContext(target: string | undefined): boolean {
  return target !== undefined && target !== "_self";
}

export function Link({
  to,
  href: hrefAlias,
  email,
  tel,
  params,
  query,
  newTab,
  component: Component = "a",
  children,
  onClick,
  ...elementProps
}: LinkProps): ReactElement {
  const { url, isInApp } = resolveDestination({
    to,
    href: hrefAlias,
    email,
    tel,
    params,
    query,
  });

  const target = elementProps.target ?? (newTab === true ? "_blank" : undefined);

  // Only a DEFAULT: a caller that wrote its own `rel` (`"me noopener"`,
  // `"external"`) meant it, and overwriting it would delete a value the page
  // depends on to say something this component knows nothing about.
  const rel =
    elementProps.rel ?? (target === "_blank" ? "noopener noreferrer" : undefined);

  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    // The caller's handler runs FIRST and unconditionally — it may be doing
    // analytics, closing a menu, or calling `preventDefault()` to veto the
    // navigation outright. Deciding before it ran would let this component
    // navigate away from a click the application had already cancelled.
    onClick?.(event);

    // `mailto:`, `tel:` and anything aimed at another browsing context leave
    // this page standing. The runtime is not consulted at all — asking it would
    // spend a page-data fetch on a click that was never going to navigate here.
    if (!isInApp || opensAnotherContext(target)) return;

    if (!isPlainLeftClick(event)) return;

    /*
      Asked for per click, never captured at render: the runtime registers
      itself when the hydration bundle mounts, which is AFTER the first render
      of every anchor on the page. A value read at render time would be
      `undefined` forever for exactly the links present at hydration — that is,
      all of them.

      Absent (server render, or before hydration) the anchor is left alone and
      does what an anchor does. That is the whole progressive-enhancement story:
      links work before this code runs, and work better after.
    */
    if (currentNavigator()?.(url) !== true) return;

    event.preventDefault();
  };

  return createElement(
    Component,
    { ...elementProps, target, rel, href: url, onClick: handleClick },
    children,
  );
}
