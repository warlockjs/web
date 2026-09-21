import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { DocumentContext } from "../../components/document-context";
import { DefaultErrorBoundary } from "../default-error-boundary";
import { LocaleProvider } from "../../localization";
import { scopedPayloadTranslations } from "../install-payload-translations";
import type {
  HydrationDocumentPayloadSource,
  SerializedErrorPageProps,
} from "../../hydration-payload";
import { connectNavigator } from "../../routing/navigator";
import { routerEvents, type NavigationMode } from "../../routing/router-events";
import {
  fragmentOf,
  samePageFragment,
  withFragmentFrom,
  withoutFragment,
} from "../../routing/url-fragment";
import { hydrateShared } from "../../shared";
import type { ClientPageEntry } from "../runtime";
import { recordCurrentRoute } from "./current-route";
import { DOCUMENT_SCOPE, releaseDeferredScope } from "../runtime/defer-registry";
import { resolveErrorPageComponent } from "./resolve-error-page-component";
import { applyDocumentMetadata } from "./document-metadata";
import { connectLocaleChanger, createLocaleChanger } from "./change-locale-code";
import { fetchPageData } from "./fetch-page-data";
import { createEntryKey, ensureEntryKey, withEntryKey } from "./history-entry-key";
import { takePrefetchedPageData } from "./prefetch";
import { connectRefresher, createRefresher, type RefreshablePage } from "./refresh";
import {
  applyScrollPosition,
  captureScrollPosition,
  decideNewNavigationScroll,
  decidePopStateScroll,
  installManualScrollRestoration,
  scrollToTop,
  type ScrollDecision,
} from "./scroll-restoration";
import { hydrateScrollPositions } from "./scroll-positions";
import { scrollToFragment } from "./scroll-to-fragment";
import { syncDocumentLocale } from "./sync-document-locale";

/**
 * Carry out a scroll decision (`scroll-restoration.ts`) once the target
 * content is actually on screen — a fragment lookup, a restored position, or
 * a plain scroll-to-top, and nothing here decides WHICH.
 */
function applyScrollDecision(decision: ScrollDecision): void {
  switch (decision.type) {
    case "restore":
      applyScrollPosition(decision.position);

      return;
    case "top":
      scrollToTop();

      return;
    case "fragment":
      scrollToFragment(document, decision.fragment);

      return;
  }
}

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

  /*
    THE DEFAULT ERROR BOUNDARY'S RESET SIGNAL. Bumped by `applySwap` below —
    the one place every applied payload swap passes through, whether it is a
    navigation, a `refresh()`, or a locale change — and handed to
    `DefaultErrorBoundary` as `resetToken` instead of keying it on
    `current.payload.name`: a same-name swap (`/posts/1` -> `/posts/2`, or a
    plain `refresh()`) must also clear a stale error, and a changing `key`
    would remount the layouts inside it to do that, throwing away the state
    client navigation exists to keep. A ref, not state: it has nothing to
    render on its own, and mutating it before the `setCurrent` that follows
    guarantees the boundary sees the new value on the very render the swap
    causes.
  */
  const resetTokenRef = useRef(0);

  // Set once the initial document's deferred scope has been released.
  const documentScopeReleased = useRef(false);

  /*
    THE DEFAULT FLOOR'S ERROR PAGE, resolved independently of `current.tree`.
    A route's `error.page.tsx` is loaded the same way `buildTree` loads its
    ordinary `Page` — an async module fetch, resolved here rather than
    threaded through `buildTree`'s own result so this component stays the one
    place that owns `DefaultErrorBoundary`'s props, and so a caller's
    existing `buildTree` (returning a plain `ReactNode`, unchanged) keeps
    working unmodified.

    Kept in STATE, not a ref: unlike `resetTokenRef` (mutated synchronously,
    always fresh by the render its own swap causes), this resolves later,
    off a dynamic import — nothing else would force `DefaultErrorBoundary` to
    receive the freshly loaded component once that import settles.

    Reset to `undefined` on every route-name change, not kept until the new
    one resolves: a stale error page from the page just left must not render
    for a failure on the page just arrived at.
  */
  const [errorPageComponent, setErrorPageComponent] = useState<
    ComponentType<SerializedErrorPageProps> | undefined
  >(undefined);

  useEffect(() => {
    let cancelled = false;

    setErrorPageComponent(undefined);

    resolveErrorPageComponent(pages, current.payload.name)
      .then((component) => {
        // Wrapped: a component IS a function, and a bare function passed to a
        // state setter is called as an updater rather than stored.
        if (!cancelled) setErrorPageComponent(() => component);
      })
      .catch(() => {
        if (!cancelled) setErrorPageComponent(undefined);
      });

    return () => {
      cancelled = true;
    };
  }, [pages, current.payload.name]);

  const applySwap = (next: Current): void => {
    resetTokenRef.current += 1;

    setCurrent(next);
  };

  /*
    THE ORDERING PROBLEM, and this ref is half of the answer to it.

    Whatever the scroll bar should do next — jump to a fragment's element,
    restore a saved position, or go to the top — names a target that lives in
    the tree that has not been built yet: at the moment `apply` finishes
    fetching, the DOM still holds the page the user is LEAVING. Acting there
    finds nothing, or scrolls the wrong document's layout, and either failure
    is silent.

    So the decision is not carried out; it is HANDED OVER. `apply` (and
    `onPopState`, for a hash-only move that swaps no tree) parks it here
    immediately before the `setCurrent` that swaps the tree, and the layout
    effect below — which React runs after it has committed that tree to the DOM
    and before the browser paints — spends it. Read the two together; neither
    half means anything alone.
  */
  const pendingScroll = useRef<ScrollDecision | undefined>(undefined);

  /**
   * The key of the history entry currently on screen — set once at boot from
   * whatever is already on `history.state` (minting one if this is the first
   * time this document has seen this entry), and kept current on every swap.
   * Read by the navigator and `onPopState` to know WHICH entry's scroll
   * position they are about to capture, immediately before it stops being the
   * one on screen.
   */
  const activeEntryKey = useRef<string>("");

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
      The controller behind the one in-flight `fetchPageData` request that
      still matters. Claiming a new ticket aborts it first — see
      `claimTicket` below — so at most one request is ever left running past
      the moment something newer starts.
    */
    let activeController: AbortController | undefined;
    /*
      The URL this runtime last put in the address bar, so `popstate` can tell a
      move BETWEEN pages from a move between two fragments of one page. Seeded
      with the URL the document was loaded at, which is the entry the first Back
      would come from.
    */
    let committedUrl = window.location.href;

    /*
      Scroll restoration boots ONCE, here, alongside `committedUrl` — both are
      "what does this runtime already know about the entry it started on".
      `history.scrollRestoration = "manual"` from this point forward means the
      browser will not move the scroll bar on Back/Forward by itself, which is
      what makes this runtime's own restoration (below) the only thing doing
      it — and able to do it AFTER the swapped page has rendered rather than
      before, which native restoration cannot promise against a page whose
      content is still loading in.
    */
    installManualScrollRestoration(window.history);
    hydrateScrollPositions();
    activeEntryKey.current = ensureEntryKey(window.history);

    /**
     * @param kind `"navigate"` for a navigation the app asked for — a
     * `<Link>` click, `navigateTo` — which always mints a NEW entry key and
     * scrolls to the top unless the URL names a fragment. `"popstate"` for
     * Back/Forward, which reads back the entry's own key and restores its
     * saved scroll position, falling back to its fragment and then to the top
     * — see `scroll-restoration.ts`'s `decidePopStateScroll`.
     *
     * The fragment is PRESERVED in the URL for both cases — see below —
     * whether or not this navigation's decision ends up being `"fragment"`.
     */
    const apply = async (
      url: string,
      replace: boolean,
      kind: "navigate" | "popstate",
    ): Promise<void> => {
      const { isCurrent, signal } = claimTicket();
      /*
        `"replace"` covers a Back/Forward press as well as an explicit
        `<Link replace>` — both calls into `apply` pass `replace: true` for
        exactly that reason (see `onPopState` below), and `NavigationMode`'s own
        doc records why a listener does not need the two told apart.
      */
      const mode: NavigationMode = replace ? "replace" : "push";

      routerEvents.emitNavigating({ url, mode });
      /*
        A prefetched response is CONSUMED, never merely read — `take` removes it,
        so the same speculative fetch can satisfy exactly one navigation and a
        second click on the same link goes to the network. That matters because
        the HTTP cache cannot stand in for this: dev responses are `no-store`
        (`server/dev-server.ts:254`) and production is `private` with no
        `max-age` (`server/render-page.ts:432`), so the browser will not reliably
        replay the speculative response on the real click.

        The race guard below still holds on a cache hit: `??` short-circuits the
        await, and the synchronous path reaches the same `isCurrent()` check.
        A prefetched hit is never aborted — there is no request in flight to
        abort — so `signal` is only ever consulted on the network path.
      */
      const result = takePrefetchedPageData(url) ?? (await fetchPageData(url, signal));

      if (disposed || !isCurrent()) return;

      if (result.type === "aborted") {
        // Superseded — the ticket already told us so, and would have caught
        // this even if aborting had done nothing (a test double that ignores
        // `signal`, or a response that raced the abort). Not an error, not a
        // fallback: the operation that overtook this one reports its own
        // outcome.
        return;
      }

      if (result.type === "hard-navigate") {
        // The documented degradation: hand the URL back to the browser. The
        // user still gets the page — see `fetch-page-data.ts`. Announced as a
        // navigation ERROR, not a navigated one: `NavigationErrorPayload`'s own
        // doc names this exact case — the in-flight navigation is over, not
        // completed within this document.
        const error = new Error(
          `Warlock navigation fell back to a full load (${result.reason}): ${url}`,
        );

        console.warn(`Warlock navigation fell back to a full load (${result.reason}):`, url);
        routerEvents.emitNavigationError({ url, mode, error });
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
        routerEvents.emitNavigationError({ url, mode, error });
        window.location.assign(url);

        return;
      }

      if (disposed || !isCurrent()) return;

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

      /*
        History AFTER the fetch succeeded, never before. Pushing optimistically
        would leave the address bar pointing at a page that then failed to
        load, and a Back press would return to a URL the user never saw.

        The entry's key travels WITH the write: a `"navigate"` mints a fresh
        one — this is always a new logical page, even when it replaces the
        current entry — and a `"popstate"` keeps the one already on
        `history.state`, since this call is fixing the fragment back onto a URL
        the browser already navigated to, not creating a new entry.
      */
      const entryKey = kind === "navigate" ? createEntryKey() : ensureEntryKey(window.history);
      const state = kind === "navigate" ? withEntryKey(null, entryKey) : window.history.state;

      if (replace) {
        window.history.replaceState(state, "", finalUrl);
      } else {
        window.history.pushState(state, "", finalUrl);
      }

      committedUrl = finalUrl;
      activeEntryKey.current = entryKey;

      // Handed to the layout effect, which runs once React has committed the
      // tree below to the DOM — the first moment the target can exist.
      pendingScroll.current =
        kind === "navigate"
          ? decideNewNavigationScroll(fragmentOf(finalUrl))
          : decidePopStateScroll(entryKey, fragmentOf(finalUrl));

      // A navigation IS the route moving, so the fetched payload is both the
      // page and the route's identity.
      applySwap({ payload: result.payload, tree, routeSource: result.payload });

      // The initial document's deferred values have no stream reader of their
      // own to release them, so the first page that replaces it does. By now
      // the document stream has closed and every pending key has settled.
      if (!documentScopeReleased.current) {
        documentScopeReleased.current = true;
        releaseDeferredScope(DOCUMENT_SCOPE);
      }

      routerEvents.emitNavigated({ url, resolvedUrl: finalUrl, mode });
    };

    /*
      The same counter `apply` above takes its tickets from, handed to
      `refresh()` and `changeLocaleCode()` too. ONE mechanism, not two: a
      refresh, a locale change and a navigation can each overtake the others
      in any direction, and separate counters would leave each blind to the
      others.

      Claiming a ticket also aborts whatever request the PREVIOUS ticket
      holder started, and hands the new ticket holder a fresh signal of its
      own. This is an optimisation layered on the counter, not a second
      arbiter: `isCurrent()` — checked by every caller, abort or no abort —
      is still what decides which response wins. Aborting only stops the
      browser doing work nobody will look at.
    */
    const claimTicket = (): { isCurrent: () => boolean; signal: AbortSignal } => {
      activeController?.abort();

      const controller = new AbortController();

      activeController = controller;

      const ticket = ++token;

      return { isCurrent: () => !disposed && ticket === token, signal: controller.signal };
    };

    // Both the refresher and the locale changer are one seam, built from the
    // same four callbacks (see `refresh.ts`'s `RefreshRuntime`): a refresh, a
    // locale change and a navigation can each overtake the others, and only
    // sharing `claimTicket`'s counter lets any of them notice.
    const runtime = {
      readCurrent: () => currentRef.current,
      writeCurrent: applySwap,
      buildTree: (payload: HydrationDocumentPayloadSource) => buildTree(pages, payload),
      claimTicket,
    };

    const previousRefresher = connectRefresher(createRefresher(runtime));
    const previousLocaleChanger = connectLocaleChanger(createLocaleChanger(runtime));

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
        const entryKey = createEntryKey();

        if (replace) {
          window.history.replaceState(withEntryKey(null, entryKey), "", url);
        } else {
          window.history.pushState(withEntryKey(null, entryKey), "", url);
        }

        committedUrl = window.location.href;
        activeEntryKey.current = entryKey;

        // The target is in the DOM already, so there is nothing to wait for —
        // and nothing to hand to the layout effect, which no swap would fire.
        scrollToFragment(document, fragment);

        return true;
      }

      // The entry being LEFT, captured before anything below moves the page —
      // `apply` mints the entry being arrived at, so this is the last point at
      // which `activeEntryKey` still names the outgoing one.
      captureScrollPosition(activeEntryKey.current);

      void apply(url, replace, "navigate");

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
        The entry being LEFT. The browser has already moved
        `window.location`/`history.state` onto the TARGET entry by the time
        `popstate` fires, so `activeEntryKey` — not anything read from the DOM
        or history right now — is the only remaining record of which entry
        that was, and this is the last instant it still names it.
      */
      captureScrollPosition(activeEntryKey.current);

      /*
        A hash-only move within one page — Back off a `#section` click, or
        Forward onto one. The document is the same document and the tree on
        screen is already the right tree, so there is nothing to fetch: the
        browser has changed the URL, but scroll restoration is manual now (see
        the mount effect above), so restoring the position — or falling back to
        the fragment — is still this runtime's job, and it is done immediately
        rather than handed to the layout effect, since no tree swap is coming
        to trigger one.
      */
      const hashOnlyMove = withoutFragment(target) === withoutFragment(committedUrl);

      committedUrl = target;

      if (hashOnlyMove) {
        const entryKey = ensureEntryKey(window.history);

        activeEntryKey.current = entryKey;
        applyScrollDecision(decidePopStateScroll(entryKey, fragmentOf(target)));

        return;
      }

      void apply(target, true, "popstate");
    };

    window.addEventListener("popstate", onPopState);

    return () => {
      disposed = true;
      activeController?.abort();
      window.removeEventListener("popstate", onPopState);
      connectNavigator(previousNavigator);
      connectRefresher(previousRefresher);
      connectLocaleChanger(previousLocaleChanger);
    };
  }, [pages, buildTree]);

  /*
    THE OTHER HALF OF THE ORDERING PROBLEM (see `pendingScroll` above).

    `useLayoutEffect`, not `useEffect`, and the difference is the whole point:
    React runs a layout effect after it has COMMITTED this render to the DOM and
    BEFORE the browser paints. That is the earliest instant the new page's
    elements exist — a scroll any sooner finds nothing, or restores a position
    against the OLD page's layout — and the last instant before the user sees
    anything, so the page is never painted at the wrong position and then
    jumped. `useEffect` would satisfy the first requirement and not the
    second: it runs after paint, which is a visible flash of the wrong position.

    This is also why a page with a deferred value is restored after its FIRST
    commit rather than after the deferred value settles: a deferred key resolves
    a Suspense boundary already inside the committed tree (`defer-registry.ts`),
    which is a LATER commit this effect does not re-run for (it is keyed on
    `current`, which does not change when a deferred value arrives) — so there
    is nothing here that could wait for one even accidentally.

    Keyed on `current` rather than reaching for a fresh render: the effect fires
    on the swap that put the target in the DOM, so no polling, no rAF, no
    timeout. What it CANNOT wait for is content that arrives later still — an
    image without dimensions above the target, a component that suspends — which
    moves the target after we have scrolled to where it was. That is the known
    limit of this mechanism and it is the same one a browser has.

    Consumed once: the decision is cleared as it is read, so a later re-render
    (a refresh, a parent's state change) does not yank the page back to a
    position or an anchor the user has since scrolled away from.
  */
  useLayoutEffect(() => {
    const decision = pendingScroll.current;

    if (decision === undefined) return;

    pendingScroll.current = undefined;

    applyScrollDecision(decision);
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
    The locale `documentElement.lang`/`dir` currently reflect. Seeded with the
    HYDRATION payload's locale, which is the point: on the initial mount the
    document is the server's own render for that locale
    (`components/default-app.tsx:25`), so there is nothing to correct — only a
    SWAP (a navigation, a refresh, or `changeLocaleCode`) can leave it stale,
    because `root.tsx` sits outside the hydrated subtree and no client render
    reaches it (`skills/write-the-root/SKILL.md`). Keyed on the locale value
    itself, not the payload, so a refresh that produces a new payload object
    for the SAME locale does not re-write attributes that are already correct.
  */
  const appliedLocale = useRef(current.payload.locale);

  useEffect(() => {
    if (appliedLocale.current === current.payload.locale) return;

    appliedLocale.current = current.payload.locale;

    syncDocumentLocale(document, current.payload.locale);
  }, [current.payload.locale]);

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
    a Layout (not the App level) renders its tags into `#vessel` server-side, and
    hydrating that markup against `metadata: undefined` produced a tree the
    server never rendered.
  */
  return (
    <DocumentContext.Provider
      value={{ metadata: current.payload.metadata, payload: current.payload }}
    >
      <LocaleProvider
        locale={current.payload.locale}
        translations={scopedPayloadTranslations(current.payload)}
      >
        {/*
          THE FIRST-PARTY FLOOR. NOT keyed on the page name — a changing
          `key` would remount this boundary's whole subtree, layouts
          included, on every swap, which is exactly the reconciliation
          client navigation exists to avoid (see this file's own doc on "Why
          the layout stays mounted"). `resetToken` instead: it moves on
          every applied swap too, but only clears a caught error rather than
          unmounting anything, so a fallback rendered for the page just left
          never lingers over the page just arrived at without paying for a
          layout remount to get there. An app-authored ErrorBoundary
          anywhere in `current.tree` (a layout, the page) is nearer and
          catches first; this one only fires when nothing else did — see
          `default-error-boundary.tsx`.
        */}
        <DefaultErrorBoundary resetToken={resetTokenRef.current} errorPage={errorPageComponent}>
          {current.tree}
        </DefaultErrorBoundary>
      </LocaleProvider>
    </DocumentContext.Provider>
  );
}
