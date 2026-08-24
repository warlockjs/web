import type { ReactNode } from "react";
import { hydrateRoot } from "react-dom/client";
import { DocumentContext, type DocumentContextValue } from "../components/document-context";
import { readHydrationPayload, type HydrationDocumentPayloadSource } from "../hydration-payload";
import { hydrateShared } from "../shared";

/**
 * The hydration MOUNT point — a different id from the payload script's id.
 * Not exported anywhere as a named constant (`default-app.tsx:39` only
 * renders the literal `<div id="root">`), so a local literal is fine here:
 * the contract's no-duplicate-literal rule is specifically about the payload
 * script id, which `readHydrationPayload` already owns exclusively
 * (hydration-payload-contract-2026-08-22.md §4).
 */
const MOUNT_ELEMENT_ID = "root";

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

/**
 * The awaited path's failure sink. By the time a `buildTree` promise rejects
 * the synchronous stack is gone, so there is no caller left to throw at — and
 * an un-attached rejection is a blank console, which is the silent-failure
 * class this pipeline keeps regressing into. Reported loudly, and deliberately
 * WITHOUT touching `#root`: the server's markup is correct and visible, it is
 * only un-hydrated, so clearing it would turn a degraded page into a blank one.
 */
function reportHydrationFailure(error: unknown): void {
  console.error(
    "Warlock hydration failed after the page tree was requested. The server-rendered " +
      "markup is left on screen un-hydrated; #root was not cleared.",
    error,
  );
}

/**
 * The one hydration entry point. Mounts at `#root` only — the page subtree —
 * never `document`/`html`/`head`/`body` (hydration-payload-contract-2026-08-22.md
 * §2): `metadata`, `lang`, `dir`, `nonce` are not in the client payload and are
 * never touched here. `readHydrationPayload` (web/src/hydration-payload.ts,
 * Vega's slice B) is the one place ABSENT/MALFORMED are decided, so this
 * function does not re-implement that check — reusing it is what keeps the
 * two throw messages from drifting apart at a second site. On ABSENT/MALFORMED
 * it throws before touching `#root`, so the server-rendered markup stays
 * visible; nothing is cleared or re-rendered.
 *
 * Order is load-bearing and unchanged by the async tree: payload validated,
 * shared snapshot installed, `#root` resolved and its absence thrown on — all
 * SYNCHRONOUSLY, so those three failures still reject the call itself — and
 * only then is the tree built and, if it is a promise, awaited. Nothing is
 * cleared on any failure path.
 */
export function hydratePage(buildTree: BuildHydratedTree): void {
  const payload = readHydrationPayload(document);

  hydrateShared(payload.shared);

  const mountElement = document.getElementById(MOUNT_ELEMENT_ID);

  if (mountElement === null) {
    throw new Error(
      `Warlock hydration aborted: no element with id "${MOUNT_ELEMENT_ID}" was found. The ` +
        'server is expected to render <div id="root"> as the hydration mount point ' +
        "(web/src/components/default-app.tsx:39).",
    );
  }

  const value: DocumentContextValue = { metadata: undefined, payload };

  const mount = (tree: ReactNode): void => {
    hydrateRoot(
      mountElement,
      <DocumentContext.Provider value={value}>{tree}</DocumentContext.Provider>,
    );
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