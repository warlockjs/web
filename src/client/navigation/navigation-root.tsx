import { useEffect, useRef, useState, type ReactNode } from "react";
import { DocumentContext } from "../../components/document-context";
import type { HydrationDocumentPayloadSource } from "../../hydration-payload";
import { connectNavigator } from "../../routing/navigator";
import { hydrateShared } from "../../shared";
import type { ClientPageEntry } from "../runtime";
import { recordCurrentRoute } from "./current-route";
import { fetchPageData } from "./fetch-page-data";
import { takePrefetchedPageData } from "./prefetch";
import { connectRefresher, createRefresher, type RefreshablePage } from "./refresh";

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

    const apply = async (url: string, replace: boolean): Promise<void> => {
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

      // History AFTER the fetch succeeded, never before. Pushing optimistically
      // would leave the address bar pointing at a page that then failed to
      // load, and a Back press would return to a URL the user never saw.
      if (replace) {
        window.history.replaceState(null, "", result.url);
      } else {
        window.history.pushState(null, "", result.url);
      }

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
      void apply(url, options?.replace === true);

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
      void apply(window.location.href, true);
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
  return (
    <DocumentContext.Provider value={{ metadata: undefined, payload: current.payload }}>
      {current.tree}
    </DocumentContext.Provider>
  );
}
