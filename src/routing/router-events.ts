/**
 * The navigation lifecycle emitter — what a progress bar subscribes to.
 *
 * A client navigation is a fetch followed by a tree swap
 * (`client/navigation/navigation-root.tsx`). Nothing about that is visible to
 * the user while it is in flight, which is the whole reason this module
 * exists: a progress bar, an analytics hook or a scroll restorer needs to know
 * that a navigation STARTED, that it FINISHED, and that it FAILED — and none
 * of them should have to reach into the navigation runtime to find out.
 *
 * So the runtime announces, and anyone may listen. The listeners are strangers
 * to each other and to the runtime; that is the point.
 *
 * ## This module ships the emitter only
 *
 * Nothing here is wired into the navigation runtime yet — `navigation-root.tsx`
 * calls the `emit*` methods in a later change. Until then this is a complete,
 * self-contained emitter with no callers, which is why it has no dependency on
 * anything in `client/`.
 *
 * ## What it deliberately does NOT do
 *
 * It carries URLs as OPAQUE STRINGS. There is no matching, no parsing, no
 * "which route is this" — Warlock's server router is the only matcher (canon
 * 9c8f878b), and an emitter that started parsing paths would be a second one.
 * A listener that wants a route name gets it from the payload the navigation
 * produced, not from this module.
 *
 * DIRECTORY CONTRACT — see `route-identity.ts`: nothing in `web/src/routing/`
 * may import `node:fs`, `node:path`, `vite` or `fastify`. This module also
 * touches no DOM global, which is what makes it importable from a server
 * render (see below).
 *
 * ## Named for its ancestor
 *
 * `routerEvents` is the name `@mongez/react-router` used
 * (`@mongez/react-router/src/events.ts`), and the subscription ergonomics are
 * deliberately familiar: `routerEvents.onNavigating(callback)` returns
 * something you call to stop listening. The implementation is NOT ported —
 * MRR's delegates to a global `@mongez/events` bus keyed by string
 * (`"router.navigating"`), which reaches its router singleton and gives up
 * per-event payload typing in the process. Here the events are the object's
 * own methods, so each one carries its own payload type and a typo is a
 * compile error rather than a listener that never fires.
 *
 * MRR returns an `EventSubscription` object; this returns the unsubscribe
 * FUNCTION itself, because that is what a React `useEffect` cleanup wants to
 * be handed:
 *
 * ```ts
 * useEffect(() => routerEvents.onNavigating(() => setLoading(true)), []);
 * ```
 */

/**
 * How the navigation will be written to browser history.
 *
 * `"replace"` covers both an explicit `<Link replace>` and a Back/Forward
 * press — the runtime replaces in both cases, because the history entry
 * already exists. A listener that wants to stay quiet during Back/Forward
 * cannot tell the two apart from here, and does not need to: what it actually
 * cares about is that no new entry is being pushed.
 */
export type NavigationMode = "push" | "replace";

/** Emitted when a navigation begins — before anything has been fetched. */
export type NavigationStartPayload = {
  /** The URL the navigation was requested for, verbatim and unparsed. */
  url: string;
  mode: NavigationMode;
};

/** Emitted when a navigation has completed and the new page is on screen. */
export type NavigationEndPayload = {
  /** The URL the navigation was requested for — the same string {@link NavigationStartPayload} carried. */
  url: string;
  /**
   * The URL the page data actually came from, which is what landed in the
   * address bar. It differs from `url` whenever the server redirected — a
   * page that requires auth answers from `/login` (see
   * `client/navigation/fetch-page-data.ts`).
   */
  resolvedUrl: string;
  mode: NavigationMode;
};

/**
 * Emitted when a navigation could not complete.
 *
 * A failed client navigation is not a dead end — the runtime degrades to a
 * full browser load — so a listener should treat this as "the in-flight
 * navigation is over", not as an error to render. A progress bar hides on it.
 */
export type NavigationErrorPayload = {
  /** The URL the navigation was requested for. */
  url: string;
  mode: NavigationMode;
  /**
   * What went wrong. `unknown` rather than `Error` because a caught value has
   * no such guarantee — narrow it before reading `.message`.
   */
  error: unknown;
};

/** A listener for one navigation event. Its return value is ignored. */
export type RouterEventListener<Payload> = (payload: Payload) => void;

/** Call it to stop listening. Calling it more than once is a no-op. */
export type RouterEventUnsubscribe = () => void;

/**
 * The navigation lifecycle surface: three events, each with its own payload
 * type, each subscribable and emittable.
 *
 * The `emit*` half belongs to the navigation runtime. Nothing stops other code
 * from calling it, and nothing needs to — an emitter that lies about
 * navigations is a bug in whoever called it, not a boundary worth policing.
 */
export type RouterEvents = {
  /** Subscribe to the start of every navigation. @returns the unsubscribe function. */
  onNavigating: (listener: RouterEventListener<NavigationStartPayload>) => RouterEventUnsubscribe;
  /** Subscribe to every navigation that completed. @returns the unsubscribe function. */
  onNavigated: (listener: RouterEventListener<NavigationEndPayload>) => RouterEventUnsubscribe;
  /** Subscribe to every navigation that failed. @returns the unsubscribe function. */
  onNavigationError: (
    listener: RouterEventListener<NavigationErrorPayload>,
  ) => RouterEventUnsubscribe;
  /** Announce that a navigation has begun. Called by the navigation runtime. */
  emitNavigating: (payload: NavigationStartPayload) => void;
  /** Announce that a navigation has completed. Called by the navigation runtime. */
  emitNavigated: (payload: NavigationEndPayload) => void;
  /** Announce that a navigation has failed. Called by the navigation runtime. */
  emitNavigationError: (payload: NavigationErrorPayload) => void;
};

/**
 * One registration. An OBJECT rather than the callback itself, so that
 * subscribing the same function twice is two independent registrations — a
 * registry keyed by the callback would collapse them, and then one component's
 * cleanup would silently deafen another's.
 */
type Registration<Payload> = { listener: RouterEventListener<Payload> };

type Signal<Payload> = {
  subscribe: (listener: RouterEventListener<Payload>) => RouterEventUnsubscribe;
  emit: (payload: Payload) => void;
};

/**
 * One event's registrations and its delivery loop. A `Set` because insertion
 * order is preserved (listeners fire in subscription order) and removal is by
 * identity, which is exactly what an unsubscribe closure holds.
 */
function createSignal<Payload>(eventName: string): Signal<Payload> {
  const registrations = new Set<Registration<Payload>>();

  return {
    subscribe: listener => {
      const registration: Registration<Payload> = { listener };

      registrations.add(registration);

      // `Set.delete` on an absent member is a no-op, so this is idempotent for
      // free — which matters because React StrictMode runs an effect's cleanup
      // twice in development.
      return () => {
        registrations.delete(registration);
      };
    },
    emit: payload => {
      /*
        A SNAPSHOT, not the live set. Listeners subscribe and unsubscribe from
        inside other listeners — a progress bar that hides itself, a one-shot
        analytics hook — and mutating the collection being iterated is how an
        emitter starts skipping listeners. Iterating a copy also fixes the
        cohort: a listener added during this emit belongs to the next
        navigation, not to the one already in flight.

        Removals during the emit are still honoured (the deleted-check below),
        because a listener that has just unsubscribed has said it no longer
        wants this event, and delivering it anyway is the bug that outlives the
        component.
      */
      for (const registration of [...registrations]) {
        if (!registrations.has(registration)) continue;

        try {
          registration.listener(payload);
        } catch (error) {
          /*
            THE POINT OF THE TRY. Everything downstream of an emit — the
            history entry, the tree swap — happens after this loop returns, so
            a listener that throws would otherwise take the navigation down
            with it. One broken progress bar is a broken progress bar; it is
            not a stuck page.

            Reported rather than swallowed: a listener failing silently on
            every navigation is worse than noisy. The listener STAYS
            subscribed, because one bad emit is not consent to deregister
            something the component still owns and will still try to clean up.
          */
          console.error(`Warlock routerEvents: a ${eventName} listener threw:`, error);
        }
      }
    },
  };
}

/**
 * Builds an independent emitter with no listeners.
 *
 * This is what makes the module TESTABLE without cross-test bleed, and it is
 * the escape hatch for anything that needs a private lifecycle bus. The
 * shared {@link routerEvents} is one of these, created once.
 */
export function createRouterEvents(): RouterEvents {
  const navigating = createSignal<NavigationStartPayload>("navigating");
  const navigated = createSignal<NavigationEndPayload>("navigated");
  const navigationError = createSignal<NavigationErrorPayload>("navigation-error");

  return {
    onNavigating: navigating.subscribe,
    onNavigated: navigated.subscribe,
    onNavigationError: navigationError.subscribe,
    emitNavigating: navigating.emit,
    emitNavigated: navigated.emit,
    emitNavigationError: navigationError.emit,
  };
}

/**
 * The shared navigation lifecycle emitter — the one a progress bar subscribes
 * to and the one the navigation runtime emits on.
 *
 * ## Why a module-level singleton is safe here, when module-level state is a known SSR hazard
 *
 * Canon records MRR's `RouterWrapper.tsx:63` as the cautionary case: module
 * state that holds RENDER state is shared by every concurrent request on the
 * server, so one visitor's page leaks into another's. That hazard is about
 * *what* is held, not about module scope itself — `routing/navigator.ts` in
 * this same directory already holds a module-level registration for the same
 * reason.
 *
 * This object holds ONLY listener registrations. No current route, no payload,
 * no request-scoped anything — nothing a render reads and nothing a response
 * is built from. Two concurrent SSR requests observe the same empty listener
 * sets and neither can learn a thing about the other.
 *
 * It is also safe to IMPORT on the server: constructing it touches no DOM
 * global, no `window`, no `history`, and performs no work beyond allocating
 * three empty sets. On the server nothing subscribes and nothing emits, so it
 * simply sits there — which is the correct server behaviour for a progress
 * bar.
 *
 * A singleton (rather than a context or a factory at the call site) is what
 * lets a progress bar living anywhere in the tree — or outside React
 * entirely — hear a navigation without being handed a bus by every component
 * between it and the root. That plumbing is the reason MRR made this global
 * too. Use {@link createRouterEvents} when you want an isolated one.
 */
export const routerEvents: RouterEvents = createRouterEvents();
