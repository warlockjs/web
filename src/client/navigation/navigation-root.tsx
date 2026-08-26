import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DocumentContext } from "../../components/document-context";
import type { HydrationDocumentPayloadSource } from "../../hydration-payload";
import type { MetadataOutput } from "../../metadata";
import { connectNavigator } from "../../routing/navigator";
import {
  fragmentOf,
  samePageFragment,
  withFragmentFrom,
  withoutFragment,
} from "../../routing/url-fragment";
import { hydrateShared } from "../../shared";
import type { ClientPageEntry } from "../runtime";
import { recordCurrentRoute } from "./current-route";
import { fetchPageData } from "./fetch-page-data";
import { takePrefetchedPageData } from "./prefetch";
import { connectRefresher, createRefresher, type RefreshablePage } from "./refresh";
import { scrollToFragment } from "./scroll-to-fragment";

/**
 * The component that makes a page REPLACEABLE.
 *
 * Hydration mounts a fixed tree — correct, because the first render must match
 * the server's markup byte for byte. Client navigation needs that same position
 * in the tree to be able to hold a *different* page later, which means state,
 * which means a component. This is that component and nothing more.
 *
 * ## Why the layout stays mounted
 *
 * The new tree is built by the same `buildHydratedTree` the server's payload
 * went through, so a navigation within one layout produces an element whose
 * layout components are the same types in the same positions. React reconciles
 * them rather than remounting, so layout state — an open menu, a scroll
 * container, a video — survives. That is the entire user-visible benefit of
 * client navigation, and it is a consequence of reusing the builder rather than
 * anything this file does.
 */

/**
 * ONE tag `<head>` may hold at most one of, addressed the way the browser
 * already addresses it. No marker attribute: the tags this replaces were
 * rendered by `<Head/>` on the server and carry none, and a marker would make
 * the applier ignore exactly the tags it exists to correct — the first
 * navigation's.
 */
type ManagedTag = {
  /** Finds the existing tag, server-rendered or applied by a previous swap. */
  selector: string;
  create: (documentNode: Document) => Element;
  write: (element: Element, value: string) => void;
};

function metaTag(attribute: "name" | "property", key: string): ManagedTag {
  return {
    selector: `meta[${attribute}="${key}"]`,
    create: documentNode => {
      const element = documentNode.createElement("meta");

      element.setAttribute(attribute, key);

      return element;
    },
    write: (element, value) => element.setAttribute("content", value),
  };
}

const TITLE_TAG: ManagedTag = {
  selector: "title",
  create: documentNode => documentNode.createElement("title"),
  write: (element, value) => {
    element.textContent = value;
  },
};

const CANONICAL_TAG: ManagedTag = {
  selector: 'link[rel="canonical"]',
  create: documentNode => {
    const element = documentNode.createElement("link");

    element.setAttribute("rel", "canonical");

    return element;
  },
  write: (element, value) => element.setAttribute("href", value),
};

/**
 * The metadata, resolved into (tag, value) pairs in `<Head/>`'s ORDER and by
 * `<Head/>`'s RULES — including the og fallbacks and the fact that they apply
 * only when `openGraph` is present (`components/head.ts:21-24,43-48`).
 *
 * The duplication is deliberate and it is the known cost here. `<Head/>` is a
 * React component that renders elements into a tree; this writes elements into
 * a live `<head>` that no client tree owns. They cannot be one function today,
 * but they MUST agree: the head after navigating to a URL has to equal the head
 * after landing on it, or a share preview depends on how the visitor arrived.
 * The fix is a shared descriptor list both consume — see the report's followup.
 */
function resolveManagedTags(
  metadata: MetadataOutput | undefined,
): readonly (readonly [ManagedTag, string | undefined])[] {
  const keywords =
    metadata?.keywords === undefined
      ? undefined
      : Array.isArray(metadata.keywords)
        ? metadata.keywords.join(", ")
        : (metadata.keywords as string);

  const openGraph = metadata?.openGraph;
  const twitter = metadata?.twitter;

  return [
    [TITLE_TAG, metadata?.title],
    [metaTag("name", "description"), metadata?.description],
    [metaTag("name", "keywords"), keywords],
    [CANONICAL_TAG, metadata?.canonical],
    [metaTag("name", "robots"), metadata?.robots],
    [metaTag("property", "og:title"), openGraph && (openGraph.title ?? metadata?.title)],
    [
      metaTag("property", "og:description"),
      openGraph && (openGraph.description ?? metadata?.description),
    ],
    [metaTag("property", "og:image"), openGraph?.image],
    [metaTag("property", "og:url"), openGraph?.url],
    [metaTag("property", "og:type"), openGraph?.type],
    [metaTag("name", "twitter:card"), twitter?.card],
    [metaTag("name", "twitter:title"), twitter?.title],
    [metaTag("name", "twitter:description"), twitter?.description],
    [metaTag("name", "twitter:image"), twitter?.image],
  ];
}

/**
 * Make `<head>` describe the page now on screen.
 *
 * ## Why this is imperative, and why that is not a shortcut
 *
 * `<Head/>` renders inside the App level, and the App level is deliberately NOT
 * in the hydrated tree — the client mounts at `#root`, which App contains
 * (`client/build-hydrated-tree.ts`'s header). So no client render can reach
 * `<head>`, and a swap either writes it directly or leaves the previous page's
 * title in the tab. It leaves it today; that is the bug.
 *
 * ## ABSENT MEANS REMOVED
 *
 * Every managed tag the new metadata does not set is REMOVED, not left alone.
 * `/` sets a description and `/contact-us` does not: keeping it would describe
 * the contact page with the home page's words to every crawler, share preview
 * and assistive reader that looks — a wrong answer, where an absent one is
 * merely absent. A title the new page does not set goes too, and the tab falls
 * back to the URL, which is the honest rendering of "this page did not name
 * itself".
 *
 * Only the tags `<Head/>` renders FROM METADATA are touched. The charset meta
 * is rendered unconditionally and belongs to the document, so it is left alone.
 *
 * Takes the document as an argument rather than reaching for the global, which
 * is what makes it provable in a suite with no DOM.
 */
export function applyDocumentMetadata(
  documentNode: Document,
  metadata: MetadataOutput | undefined,
): void {
  for (const [tag, value] of resolveManagedTags(metadata)) {
    const existing = documentNode.querySelector(tag.selector);

    if (value === undefined) {
      existing?.remove();
      continue;
    }

    if (existing !== null) {
      tag.write(existing, value);
      continue;
    }

    const created = tag.create(documentNode);

    tag.write(created, value);
    documentNode.head.appendChild(created);
  }
}

export type NavigationRootProps = {
  pages: readonly ClientPageEntry[];
  /** The payload the document was rendered from — the hydration one. */
  initialPayload: HydrationDocumentPayloadSource;
  /** The tree already built from {@link initialPayload}, rendered as-is first. */
  initialTree: ReactNode;
  /**
   * How a payload becomes a tree. Injected rather than imported so this
   * component is testable without the page registry or a bundler — the same
   * reason `hydratePage` takes its builder as an argument.
   */
  buildTree: (
    pages: readonly ClientPageEntry[],
    payload: HydrationDocumentPayloadSource,
  ) => Promise<ReactNode>;
};

/**
 * The page on screen. Defined in `refresh.ts` because the third field is that
 * file's decision: `routeSource` is the payload object `current-route.ts`
 * identifies the route by, which is `payload` after a navigation but the
 * PREVIOUS page's object after a refresh — a refresh must not shift
 * `previousRoute()` onto the page the user is already looking at.
 */
type Current = RefreshablePage;

export function NavigationRoot({
  pages,
  initialPayload,
  initialTree,
  buildTree,
}: NavigationRootProps) {
  const [current, setCurrent] = useState<Current>({
    payload: initialPayload,
    tree: initialTree,
    routeSource: initialPayload,
  });

  /*
    The latest state, readable from the effect below — which closes over the
    render that created it and would otherwise see the page the user was on
    when the runtime connected. A ref rather than an effect dependency because
    re-running the effect on every swap would disconnect and reconnect the
    navigator mid-navigation.
  */
  const currentRef = useRef(current);

  currentRef.current = current;

  /*
    THE ORDERING PROBLEM, and this ref is half of the answer to it.

    The element a fragment names lives in the tree that has not been built yet:
    at the moment `apply` finishes fetching, the DOM still holds the page the
    user is LEAVING. Scrolling there finds nothing, and finding nothing is
    silent — indistinguishable from the fragment bug itself.

    So the fragment is not scrolled to; it is HANDED OVER. `apply` parks it here
    immediately before the `setCurrent` that swaps the tree, and the layout
    effect below — which React runs after it has committed that tree to the DOM
    and before the browser paints — spends it. Read the two together; neither
    half means anything alone.
  */
  const pendingFragment = useRef<string | undefined>(undefined);

  useEffect(() => {
    /*
      THE RACE THIS COUNTER EXISTS FOR. Two clicks in quick succession start two
      fetches; the second can easily answer first (a cached page beating an
      uncached one is the common case, not the exotic one). Without a token the
      slower FIRST response lands last and the user ends up on the page they
      navigated away from, with the address bar showing the other one.

      Every navigation takes a token; a result is applied only if its token is
      still the newest. Superseded responses are dropped silently — they are not
      errors, they are answers to a question the user stopped asking.
    */
    let token = 0;
    let disposed = false;
    /*
      The URL this runtime last put in the address bar, so `popstate` can tell a
      move BETWEEN pages from a move between two fragments of one page. Seeded
      with the URL the document was loaded at, which is the entry the first Back
      would come from.
    */
    let committedUrl = window.location.href;

    /**
     * @param honourFragment whether the URL's fragment should be SCROLLED to
     * once the new page is on screen. True for a navigation the app asked for
     * — a `<Link>` click, `navigateTo` — and false for Back/Forward, where the
     * browser has already restored the scroll position of the entry being
     * returned to and moving the page again would overwrite the user's own
     * position with the anchor they had scrolled away from. (Restoration is
     * the browser's, deliberately: canon `0342c0d4`.)
     *
     * The fragment is still PRESERVED in the URL in both cases — see below.
     */
    const apply = async (
      url: string,
      replace: boolean,
      honourFragment: boolean,
    ): Promise<void> => {
      const ticket = ++token;
      /*
        A prefetched response is CONSUMED, never merely read — `take` removes it,
        so the same speculative fetch can satisfy exactly one navigation and a
        second click on the same link goes to the network. That matters because
        the HTTP cache cannot stand in for this: dev responses are `no-store`
        (`server/dev-server.ts:254`) and production is `private` with no
        `max-age` (`server/render-page.ts:432`), so the browser will not reliably
        replay the speculative response on the real click.

        The race guard below still holds on a cache hit: `??` short-circuits the
        await, and the synchronous path reaches the same `ticket !== token` check.
      */
      const result = takePrefetchedPageData(url) ?? (await fetchPageData(url));

      if (disposed || ticket !== token) return;

      if (result.type === "hard-navigate") {
        // The documented degradation: hand the URL back to the browser. The
        // user still gets the page — see `fetch-page-data.ts`.
        console.warn(`Warlock navigation fell back to a full load (${result.reason}):`, url);
        window.location.assign(url);

        return;
      }

      let tree: ReactNode;

      try {
        tree = await buildTree(pages, result.payload);
      } catch (error) {
        // The payload was fine but its page chunk would not load or compose —
        // a stale bundle after a deploy is the realistic cause. A full load
        // fetches the current bundle, which is also the fix.
        console.warn("Warlock navigation could not build the page tree:", error);
        window.location.assign(url);

        return;
      }

      if (disposed || ticket !== token) return;

      /*
        Shared state BEFORE the render that consumes it. `hydrateShared`
        installs the snapshot `useShared()` reads; swapping the tree first would
        render one frame of the new page against the previous page's shared
        state — locale, permissions, the current user.
      */
      hydrateShared(result.payload.shared);

      /*
        The fragment PUT BACK. `result.url` comes from `response.url`, and a
        fragment is never sent to a server, so the URL a navigation would
        otherwise be written to history from has had it stripped — which is how
        `<Link href="/docs#install">` used to land on `/docs` with the author's
        fragment gone from the address bar for good.

        Applied on EVERY path, Back included: a popstate re-fetch that wrote
        `result.url` back would delete the fragment from an entry the user is
        merely returning to.
      */
      const finalUrl = withFragmentFrom(result.url, url);

      // History AFTER the fetch succeeded, never before. Pushing optimistically
      // would leave the address bar pointing at a page that then failed to
      // load, and a Back press would return to a URL the user never saw.
      if (replace) {
        window.history.replaceState(null, "", finalUrl);
      } else {
        window.history.pushState(null, "", finalUrl);
      }

      committedUrl = finalUrl;

      // Handed to the layout effect, which runs once React has committed the
      // tree below to the DOM — the first moment the target can exist. Set
      // unconditionally so a navigation with no fragment CLEARS a fragment left
      // pending by one that was superseded.
      pendingFragment.current = honourFragment ? fragmentOf(finalUrl) : undefined;

      // A navigation IS the route moving, so the fetched payload is both the
      // page and the route's identity.
      setCurrent({ payload: result.payload, tree, routeSource: result.payload });
    };

    /*
      The same counter `apply` above takes its tickets from, handed to
      `refresh()` as a predicate. ONE mechanism, not two: a refresh and a
      navigation can overtake each other in either direction, and separate
      counters would leave each blind to the other.
    */
    const claimTicket = (): (() => boolean) => {
      const ticket = ++token;

      return () => !disposed && ticket === token;
    };

    const previousRefresher = connectRefresher(
      createRefresher({
        readCurrent: () => currentRef.current,
        writeCurrent: setCurrent,
        buildTree: payload => buildTree(pages, payload),
        claimTicket,
      }),
    );

    const previousNavigator = connectNavigator((url, options) => {
      const replace = options?.replace === true;

      /*
        THIS page with a fragment on it — `#reviews`, or the current path spelled
        out with one appended. No fetch, no tree swap: the page is already here,
        and re-fetching it would discard its DOM and everything live in it to
        arrive back where we started, one round trip later. Address bar first,
        then the jump, which is the order the browser uses for a plain anchor.
      */
      const fragment = samePageFragment(url, window.location.href);

      if (fragment !== undefined) {
        if (replace) {
          window.history.replaceState(null, "", url);
        } else {
          window.history.pushState(null, "", url);
        }

        committedUrl = window.location.href;

        // The target is in the DOM already, so there is nothing to wait for —
        // and nothing to hand to the layout effect, which no swap would fire.
        scrollToFragment(document, fragment);

        return true;
      }

      void apply(url, replace, true);

      // Accepted: the caller suppresses the browser's default. Returning `true`
      // before the fetch resolves is deliberate — the decision to handle a link
      // cannot wait on the network without the browser having already followed
      // it.
      return true;
    });

    /*
      Back/Forward. The entry is already in history and the URL has already
      changed by the time this fires, so the page is fetched and swapped with
      `replace` — pushing here would append a duplicate entry and make Back
      require two presses.
    */
    const onPopState = (): void => {
      const target = window.location.href;
      /*
        A hash-only move within one page — Back off a `#section` click, or
        Forward onto one. The document is the same document and the tree on
        screen is already the right tree, so there is nothing to fetch: the
        browser has changed the URL and restored the position for that entry
        itself, and re-fetching would throw away a live page to rebuild the one
        already showing. Scroll restoration stays the browser's (canon
        `0342c0d4`), which is exactly what leaving this alone means.
      */
      const hashOnlyMove = withoutFragment(target) === withoutFragment(committedUrl);

      committedUrl = target;

      if (hashOnlyMove) return;

      void apply(target, true, false);
    };

    window.addEventListener("popstate", onPopState);

    return () => {
      disposed = true;
      window.removeEventListener("popstate", onPopState);
      connectNavigator(previousNavigator);
      connectRefresher(previousRefresher);
    };
  }, [pages, buildTree]);

  /*
    THE OTHER HALF OF THE ORDERING PROBLEM (see `pendingFragment` above).

    `useLayoutEffect`, not `useEffect`, and the difference is the whole point:
    React runs a layout effect after it has COMMITTED this render to the DOM and
    BEFORE the browser paints. That is the earliest instant the new page's
    elements exist — a scroll any sooner finds nothing — and the last instant
    before the user sees anything, so the page is never painted at the top and
    then jumped. `useEffect` would satisfy the first requirement and not the
    second: it runs after paint, which is a visible flash of the wrong position.

    Keyed on `current` rather than reaching for a fresh render: the effect fires
    on the swap that put the target in the DOM, so no polling, no rAF, no
    timeout. What it CANNOT wait for is content that arrives later still — an
    image without dimensions above the target, a component that suspends — which
    moves the target after we have scrolled to where it was. That is the known
    limit of this mechanism and it is the same one a browser has.

    Consumed once: the fragment is cleared as it is read, so a later re-render
    (a refresh, a parent's state change) does not yank the page back to an
    anchor the user has since scrolled away from.
  */
  useLayoutEffect(() => {
    const fragment = pendingFragment.current;

    if (fragment === undefined) return;

    pendingFragment.current = undefined;

    scrollToFragment(document, fragment);
  }, [current]);

  /*
    The payload whose metadata `<head>` currently reflects. Seeded with the
    HYDRATION payload, which is the point: on the initial mount the head is the
    server's own render of this very metadata, so there is nothing to correct —
    and re-applying would be a chance to get it wrong, since a payload from a
    build with no `metadata` key would wipe a head the server filled in
    correctly. The head is applied on SWAPS only.
  */
  const appliedMetadataSource = useRef(current.payload);

  useEffect(() => {
    if (appliedMetadataSource.current === current.payload) return;

    appliedMetadataSource.current = current.payload;

    /*
      Keyed on the payload's identity, so this covers a refresh as well as a
      navigation: `refresh()` produces a NEW payload for the page already on
      screen, and a page whose metadata is a function of its loader data can
      legitimately re-title itself when that data changes. One applier at the
      one place the page changes, rather than a call in each pathway that could
      be forgotten in the next one.
    */
    applyDocumentMetadata(document, current.payload.metadata);
  }, [current.payload]);

  /*
    DURING RENDER, not in an effect, and that placement is the requirement
    rather than a shortcut. A page component calling `currentRoute()` does it
    while IT is rendering, and child effects run before a parent's, so anything
    recorded from an effect here would be recorded too late to answer the first
    render of the page it describes — which on the initial mount is the only
    render there has been, and the server's match is all there is.

    Recording is keyed on the payload's identity (`current-route.ts`), so the
    extra passes render gives us for free — StrictMode's double invoke, a parent
    re-render — are recognised as the same page rather than counted as
    navigations.

    `routeSource`, NOT `payload`: they are the same object for every navigation,
    and differ only after a refresh, which produces a new payload for the page
    already on screen and must not be counted as a move (see `refresh.ts`).
  */
  recordCurrentRoute(current.routeSource);

  /*
    An INNER DocumentContext provider, nested inside the one `hydratePage`
    mounted. That outer provider is created once with the hydration payload and
    never changes, so anything reading the document context after a navigation
    would see the payload of the page the user has left. The nearest provider
    wins, so this one keeps it current.
  */
  /*
    `metadata` from the PAYLOAD, not `undefined`. The document context is the
    universal shape — the server provides the resolved metadata around the same
    tree — so handing the client's readers `undefined` was a lie the payload can
    now correct. It also removes a latent mismatch: a `<Head/>` rendered inside
    a Layout (not the App level) renders its tags into `#root` server-side, and
    hydrating that markup against `metadata: undefined` produced a tree the
    server never rendered.
  */
  return (
    <DocumentContext.Provider
      value={{ metadata: current.payload.metadata, payload: current.payload }}
    >
      {current.tree}
    </DocumentContext.Provider>
  );
}
