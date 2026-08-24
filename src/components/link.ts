import { createElement } from "react";
import type {
  AnchorHTMLAttributes,
  ComponentType,
  FocusEvent,
  MouseEvent,
  ReactElement,
} from "react";
import { prefetchPageData } from "../client/navigation/prefetch";
import { currentNavigator } from "../routing/navigator";
import { href, knownRouteNames } from "../routing/route-table";

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
 * `href`, `newTab`, `email`, `tel`, `component` and `prefetch` are spelled
 * exactly as MRR spells them, so a component moved across keeps compiling.
 * `params` and `query` are ours and have no MRR equivalent: they pair with the
 * typed `href()` helper, which is what makes a route NAME — rather than a URL —
 * the thing a call site names.
 *
 * ── The semantic divergence this file bridges ────────────────────────────────
 * MRR's `to` is a PATH. Ours was a route NAME, and only a name — which meant a
 * component moved across from MRR compiled and then threw at render, because
 * `"/products"` is not the name of anything. The two packages disagreed about
 * what the most-used prop in either of them MEANS.
 *
 * Since 2026-08-24 (owner ruling) `to`/`href` accept BOTH, discriminated by
 * SHAPE — see {@link isLiteralUrl}. That is what makes MRR code portable, and
 * it costs nothing at a Warlock call site, because the two grammars cannot
 * collide: a route name never begins with `/` and never carries a `scheme:`.
 * The ruling RESTS on that, so this file asserts it rather than trusting it
 * ({@link RouteNameShapeCollisionError}).
 */

type AnchorProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">;

/**
 * Where the link goes. Every field is documented here once; which COMBINATIONS
 * are legal is decided by {@link LinkDestination}.
 */
type LinkDestinationProps = {
  /**
   * A route NAME, or a literal URL — told apart by SHAPE.
   *
   * `"products.details"` is a NAME and is resolved through the route table. A
   * page that moves changes its URL and keeps its name, so every call site
   * survives the move; a dead name throws at render naming the routes that do
   * exist, rather than rendering an anchor that 404s. This is the form to
   * prefer, and the only one `params` and `query` apply to.
   *
   * `"/pricing"`, `"https://stripe.com"`, `"mailto:sales@example.com"` and any
   * other `scheme:` are LITERAL — passed through to the element untouched, with
   * no route lookup at all. An app links out, and a route name is not a thing
   * you can have for a page that is not yours.
   */
  to?: string;
  /**
   * An alias of {@link to}, for parity with `@mongez/react-router`. Identical
   * in every respect, including which shapes it accepts.
   */
  href?: string;
  /** Renders a `mailto:` link. Not an in-app navigation. */
  email?: string;
  /** Renders a `tel:` link. Not an in-app navigation. */
  tel?: string;
  /**
   * Values for the route's `:param` segments, e.g. `{ id }` for
   * `"/products/:id"`. Only meaningful with a route NAME.
   */
  params?: Record<string, unknown>;
  /**
   * Query string values; an `undefined` value is omitted. Only meaningful with
   * a route NAME.
   */
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
    /**
     * Fetch this page's data when the pointer or the keyboard reaches the link,
     * so the click that follows swaps without a round trip.
     *
     * A GUESS, and treated as one everywhere: it is never awaited, a failure is
     * silent, and the click behaves exactly as it would without it. Opt-in per
     * link rather than on by default, because every prefetch is a request the
     * user did not ask for and someone pays for the bandwidth.
     *
     * IGNORED for anything that is not an in-app navigation — an external URL,
     * `mailto:`, `tel:`, `newTab`, any explicit `target`. Prefetching those
     * would mean issuing a cross-origin request to a third party on hover,
     * which is not a thing a link component may decide to do.
     */
    prefetch?: boolean;
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

export class RouteArgumentsOnLiteralUrlError extends Error {
  public constructor(
    public readonly url: string,
    public readonly providedProps: readonly string[],
  ) {
    super(
      `Warlock <Link> was given ${providedProps
        .map(name => JSON.stringify(name))
        .join(" and ")} alongside the literal URL "${url}". Those apply to a route NAME, ` +
        "which is resolved through the route table; a literal URL is passed through exactly " +
        "as written, so they would have been dropped and the link would have pointed at an " +
        "unfiltered page that still looked right at the call site. Put the values in the URL, " +
        "or name the route.",
    );
    this.name = "RouteArgumentsOnLiteralUrlError";
  }
}

/**
 * The ruling's one assumption, broken. See the module doc comment: telling a
 * literal URL from a route NAME by shape is only safe while no route is NAMED
 * like a URL, and nothing in the route pipeline validates a hand-declared
 * `route.name`. So the collision is checked at the one place it could do harm,
 * where it is a loud refusal instead of an anchor that silently points
 * somewhere else.
 */
export class RouteNameShapeCollisionError extends Error {
  public constructor(public readonly routeName: string) {
    super(
      `Warlock route table: a route is NAMED ${JSON.stringify(routeName)}, which is shaped ` +
        "like a URL. <Link> tells a literal URL from a route name by shape — a destination " +
        "starting with `/` or carrying a `scheme:` is passed through untouched — so this name " +
        "can never be resolved, and every link to it would silently point at that path " +
        "instead. Rename the route (`route = { path, name }`) to a dotted name such as " +
        `${JSON.stringify(routeName.replace(/^\/+/, "").replace(/\//g, ".") || "index")}.`,
    );
    this.name = "RouteNameShapeCollisionError";
  }
}

type Destination = {
  /** What lands on the element's `href`. */
  url: string;
  /**
   * Whether this URL is a page in THIS app — the only kind the client
   * navigation runtime may be asked about, and the only kind that may be
   * prefetched. `mailto:`, `tel:` and an external URL hand off to another
   * application or another origin entirely, so intercepting any of them would
   * break it, and speculatively fetching one would be a cross-origin request
   * the developer never asked for.
   */
  isInApp: boolean;
};

/**
 * Any RFC 3986 scheme — `https:`, `mailto:`, `tel:`, `whatsapp:`, an app's own
 * custom one. Matched generically rather than as a list of known schemes: a
 * list would silently resolve `bitcoin:...` through the route table, which is
 * the exact failure this ruling exists to remove, and it would have to grow
 * forever.
 */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Whether this destination is a URL to be used as written, rather than a route
 * name to resolve.
 *
 * The whole discriminator, and deliberately the whole of it: two cheap shape
 * tests, no parsing, no matching. Anything more would be a SECOND route matcher
 * living beside the server's, which this codebase refuses everywhere it comes
 * up — a matcher that disagreed with the real one would produce links to pages
 * that do not exist.
 */
function isLiteralUrl(destination: string): boolean {
  return destination.startsWith("/") || SCHEME_PATTERN.test(destination);
}

/**
 * Whether a literal URL addresses THIS app.
 *
 * A path is ours. A `scheme:` is not — including `https:` to our own origin,
 * which would need `window.location` to recognise and would make the answer
 * depend on where the code is running. And `//host/path` is PROTOCOL-RELATIVE:
 * it starts with a slash and is nonetheless another origin, which is precisely
 * the case a "starts with `/`" test alone would hand to the navigator, where it
 * becomes a `pushState` to a foreign origin — a SecurityError — or a
 * speculative fetch of a third-party host.
 */
function addressesThisApp(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

/**
 * Refuses the one table that would make {@link isLiteralUrl} wrong.
 *
 * Reached only for a destination already judged literal, so the cost is a scan
 * of the published names for links that were never going to hit the table
 * anyway — and zero for the route-name form, which is the common one. The right
 * permanent home for this is `publishRouteTable`, at boot, once (see the report
 * on this card).
 */
function assertNotARouteName(url: string): void {
  if (knownRouteNames().includes(url)) throw new RouteNameShapeCollisionError(url);
}

const ROUTE_ARGUMENT_PROPS = ["params", "query"] as const;

function resolveDestination(props: LinkDestinationProps): Destination {
  const provided = DESTINATION_PROPS.filter(name => props[name] !== undefined);

  if (provided.length > 1) throw new AmbiguousLinkDestinationError(provided);

  if (provided.length === 0) throw new MissingLinkDestinationError();

  if (props.email !== undefined) return { url: `mailto:${props.email}`, isInApp: false };

  if (props.tel !== undefined) return { url: `tel:${props.tel}`, isInApp: false };

  const destination = (props.to ?? props.href) as string;

  /*
    LITERAL: `/pricing`, `https://stripe.com`, `mailto:…`, `whatsapp://…`. It
    goes to the element exactly as written and the route table is never
    consulted — there is nothing to look up, and looking anyway is what used to
    throw `UnknownRouteNameError` on every link out of the application.
  */
  if (isLiteralUrl(destination)) {
    const routeArguments = ROUTE_ARGUMENT_PROPS.filter(name => props[name] !== undefined);

    if (routeArguments.length > 0) {
      throw new RouteArgumentsOnLiteralUrlError(destination, routeArguments);
    }

    assertNotARouteName(destination);

    return { url: destination, isInApp: addressesThisApp(destination) };
  }

  /*
    A NAME, resolved against the route table published at boot from the SAME
    discovery result the server registered its routes from. The previous version
    of this file restated six URLs in a literal map, so linking to any seventh
    page in the application threw — the map was the limit on what could be
    linked, and nothing said so at the call site.
  */
  return { url: href(destination, props.params, props.query), isInApp: true };
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
  prefetch,
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

  /*
    The SAME gate the click uses, asked before any speculative request exists:
    only a destination this app would have navigated to itself may be fetched
    ahead of time. `mailto:`, `tel:`, an external URL and anything aimed at
    another browsing context are all clicks that leave this page, and none of
    them has page data to fetch.
  */
  const prefetchesOnInteraction =
    prefetch === true && isInApp && !opensAnotherContext(target);

  /*
    Attached ONLY when prefetching — a link without the prop keeps whatever
    handlers the caller passed, on the element, unwrapped.

    Hover AND focus, because a keyboard user never generates the first one and
    would otherwise be the only visitor who never gets the optimisation.

    Fire-and-forget by construction: `prefetchPageData` never rejects and is
    never awaited, so nothing here can delay the event or surface a failure. It
    is also safe to reach on the server — it no-ops without a browser — which is
    why this file can import it directly rather than through a `connect*` seam
    like the navigator's. The navigator needs a seam because the runtime behind
    it drags React state and the page registry into the server bundle; the
    prefetch cache is a `Map` and a `fetch` call, inert until an event fires.
  */
  const prefetchHandlers = prefetchesOnInteraction
    ? {
        onMouseEnter: (event: MouseEvent<HTMLAnchorElement>): void => {
          elementProps.onMouseEnter?.(event);
          void prefetchPageData(url);
        },
        onFocus: (event: FocusEvent<HTMLAnchorElement>): void => {
          elementProps.onFocus?.(event);
          void prefetchPageData(url);
        },
      }
    : undefined;

  return createElement(
    Component,
    { ...elementProps, ...prefetchHandlers, target, rel, href: url, onClick: handleClick },
    children,
  );
}
