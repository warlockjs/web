/**
 * "What locale is currently on screen?" — read by `href()`'s caller,
 * `<Link>` (`../components/link.ts`), so an in-app link can be prefixed for
 * the locale the visitor is actually reading, without threading a `locale`
 * argument through every call site. `href()` itself stays untouched: it is
 * the durable, context-free primitive (emails, redirects, `Location`
 * headers — see `route-table.ts`'s own header), and none of those has a
 * "current" locale to guess at.
 *
 * ## Two DIFFERENT sources, by environment — this is the load-bearing part
 *
 * The BROWSER is one user, one document: a single process-wide slot is safe
 * there, the same reasoning `routing/navigator.ts`'s module-level
 * registration already relies on. Written by `LocaleProvider`
 * (`../localization.tsx`) during render, ONLY when `typeof window !==
 * "undefined"`.
 *
 * The SERVER is not. A Node process serves many requests concurrently, and
 * Stage 2 streaming SSR (`renderToPipeableStream`) genuinely interleaves
 * two renders across `await` boundaries — a process-wide slot written by one
 * request's `<LocaleProvider>` would be read by another request's `<Link>`
 * while both are mid-render. That is not a theoretical race: it means
 * request A's rendered markup carries request B's locale prefix, and a
 * `serverCache`-eligible page STORES and replays those wrong links to every
 * later visitor — a correctness and cache-poisoning bug, not an acceptable
 * tradeoff. So on the server this reads `currentRequestLocale()`
 * (`../shared.ts`), which resolves off the SAME per-request
 * `AsyncLocalStorage` store `shared` is scoped to
 * (`connectSharedStore(() => requestContext.getStore())`, wired once at
 * boot) — never a second ALS, and never written by this module at all.
 *
 * `globalThis` under a `Symbol.for` key for the browser slot, same reasoning
 * as `route-table.ts` and `locale-routing.ts`: in dev, the installer/tsx
 * graph and the Vite SSR module runner graph are two instances of this
 * module, and `globalThis` is the one thing both evaluations share.
 */
import { currentRequestLocale } from "../shared";

const CURRENT_LOCALE_SLOT = Symbol.for("warlock.web.currentLocale");

type CurrentLocaleHost = typeof globalThis & {
  [CURRENT_LOCALE_SLOT]?: string;
};

/**
 * Called by `LocaleProvider` on every render. A no-op on the server: see
 * this module's header for why the server must never write a process-wide
 * "current locale" at all.
 */
export function recordCurrentLocale(locale: string): void {
  if (typeof window === "undefined") return;

  (globalThis as CurrentLocaleHost)[CURRENT_LOCALE_SLOT] = locale;
}

/**
 * The active locale for `<Link>`'s prefixing — the browser's recorded
 * locale in the browser, THIS REQUEST's locale (off the per-request ALS
 * store) on the server. `undefined` when neither source has an answer yet
 * (no `LocaleProvider` has rendered in the browser; no request context on
 * the server — module load, a background job, or a test that connected no
 * resolver).
 */
export function readCurrentLocale(): string | undefined {
  if (typeof window === "undefined") return currentRequestLocale();

  return (globalThis as CurrentLocaleHost)[CURRENT_LOCALE_SLOT];
}

/**
 * Drop the recorded BROWSER locale, returning the module to its pre-render
 * state.
 *
 * Exists for tests: the browser slot is process-global, so a suite that
 * recorded one would otherwise leak it into every later test in the same
 * worker. Has no server-side counterpart to reset — the server never writes
 * anything here to begin with.
 */
export function resetCurrentLocale(): void {
  delete (globalThis as CurrentLocaleHost)[CURRENT_LOCALE_SLOT];
}
