import { startTransition, type ReactNode } from "react";
import { hydrateRoot } from "react-dom/client";
import {
  DocumentContext,
  HYDRATION_ROOT_ID,
  type DocumentContextValue,
} from "../components/document-context";
import { readHydrationPayload, type HydrationDocumentPayloadSource } from "../hydration-payload";
import { hydrateShared } from "../shared";
import { installStreamClosedRejection, prepareDeferredPageData } from "./runtime/defer-registry";

/**
 * Receives the VALIDATED payload and returns the ReactNode to hydrate. A
 * callback rather than a ready-made ReactNode: composing the real Layout(Page)
 * tree needs `payload.layoutData`/`pageData`/`shared`, which only exist after
 * `readHydrationPayload()` has already succeeded — building the tree first and
 * validating second would get the order backwards.
 *
 * A Promise is allowed because the real composer resolves the page's chunk
 * through the registry's dynamic `import()`. Returning it does NOT move the
 * payload check later: the callback is still only reached once the payload has
 * validated, and only the tree it produces is awaited.
 */
export type BuildHydratedTree = (
  payload: HydrationDocumentPayloadSource,
) => ReactNode | Promise<ReactNode>;

function isPromise(value: ReactNode | Promise<ReactNode>): value is Promise<ReactNode> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * When the payload carries a `deferred` key list (Stage 2 implementation
 * contract, rule 3), replaces each deferred `pageData` entry with a
 * registry-backed promise BEFORE hydration, and arms the stream-closed
 * rejection for `DOMContentLoaded`. Absent `deferred` leaves `pageData`
 * completely untouched and installs nothing on `window` — this is the one
 * branch point between the deferred and non-deferred hydration paths, so
 * every other line of `hydratePage` stays byte-for-byte the same either way.
 */
function prepareDeferredPayload(payload: HydrationDocumentPayloadSource): void {
  if (payload.deferred === undefined) return;

  if (isPlainRecord(payload.pageData)) {
    prepareDeferredPageData(payload.pageData, payload.deferred);
  }

  installStreamClosedRejection();
}

/**
 * The awaited path's failure sink. By the time a `buildTree` promise rejects
 * the synchronous stack is gone, so there is no caller left to throw at — and
 * an un-attached rejection is a blank console, which is the silent-failure
 * class this pipeline keeps regressing into. Reported loudly, and deliberately
 * WITHOUT touching `#vessel`: the server's markup is correct and visible, it is
 * only un-hydrated, so clearing it would turn a degraded page into a blank one.
 */
function reportHydrationFailure(error: unknown): void {
  console.error(
    "Warlock hydration failed after the page tree was requested. The server-rendered " +
      "markup is left on screen un-hydrated; #vessel was not cleared.",
    error,
  );
}

/**
 * The one hydration entry point. Mounts at `#vessel` only — the page subtree —
 * never `document`/`html`/`head`/`body`: `metadata`, `dir`, and `nonce` are
 * not used to rebuild the mounted tree; the declared `locale` key is
 * consumed by `NavigationRoot`'s provider.
 * `readHydrationPayload` (web/src/hydration-payload.ts)
 * is the one place ABSENT/MALFORMED are decided, so this
 * function does not re-implement that check — reusing it is what keeps the
 * two throw messages from drifting apart at a second site. On ABSENT/MALFORMED
 * it throws before touching `#vessel`, so the server-rendered markup stays
 * visible; nothing is cleared or re-rendered.
 *
 * Order is load-bearing and unchanged by the async tree: payload validated,
 * shared snapshot installed, `#vessel` resolved and its absence thrown on — all
 * SYNCHRONOUSLY, so those three failures still reject the call itself — and
 * only then is the tree built and, if it is a promise, awaited. Nothing is
 * cleared on any failure path.
 */
export function hydratePage(buildTree: BuildHydratedTree): void {
  const payload = readHydrationPayload(document);

  // NOT installed here: `installPayloadTranslations` (`install-payload-
  // translations.ts`) is called from inside `buildTree` itself —
  // `entry/index.ts`'s callback runs `buildHydratedTree`, which is also the
  // one function every navigation, `refresh()` and `changeLocaleCode()` swap
  // funnels through — so installing here too would extend the same locale
  // twice on every initial hydration for no second effect. `useTrans()`
  // (`../localization.tsx`) reads `@mongez/localization`'s process-global
  // table, and nothing else on the client ever fills it; `buildTree` is still
  // called, and awaited, before `mount()` below, so the table is filled
  // before the first client render regardless of which callback does it.
  prepareDeferredPayload(payload);

  hydrateShared(payload.shared);

  const mountElement = document.getElementById(HYDRATION_ROOT_ID);

  if (mountElement === null) {
    throw new Error(
      `Warlock hydration aborted: no element with id "${HYDRATION_ROOT_ID}" was found. The ` +
        `server is expected to render <div id="${HYDRATION_ROOT_ID}"> as the hydration mount ` +
        "point (web/src/components/default-app.tsx)." +
        legacyRootHint(),
    );
  }

  const value: DocumentContextValue = { metadata: undefined, payload };

  // Hydrated as a transition: at default priority React hydrates the whole
  // tree in one task that never yields (a ~470ms long task on a throttled
  // phone for a modest page). A transition lane lets the reconciler yield
  // between units of work, and a click during hydration still hydrates its
  // target first.
  const mount = (tree: ReactNode): void => {
    startTransition(() => {
      hydrateRoot(
        mountElement,
        <DocumentContext.Provider value={value}>{tree}</DocumentContext.Provider>,
      );
    });
  };

  const tree = buildTree(payload);

  if (isPromise(tree)) {
    // `void` on an ALREADY-handled chain: the rejection handler is attached
    // here, so nothing escapes as an unhandled rejection.
    void tree.then(mount, reportHydrationFailure);

    return;
  }

  mount(tree);
}

/**
 * Apps created before 5.14 may still render `<div id="root">` in their own
 * `src/web/root.tsx`; name the rename instead of only reporting a missing id.
 */
function legacyRootHint(): string {
  if (document.getElementById("root") === null) {
    return "";
  }

  return (
    ` Found <div id="root"> instead: the hydration mount was renamed to "${HYDRATION_ROOT_ID}" ` +
    "in 5.14; update src/web/root.tsx."
  );
}
