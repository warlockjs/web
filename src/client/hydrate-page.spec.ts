import { isValidElement, type ReactElement, type ReactNode } from "react";
import { stringify } from "devalue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hydrateRoot } from "react-dom/client";
import { HYDRATION_ROOT_ID, PAYLOAD_SCRIPT_ID } from "../components/document-context";
import { hydratePage, type BuildHydratedTree } from "./hydrate-page";
import { installStreamClosedRejection, prepareDeferredPageData } from "./runtime/defer-registry";

/**
 * React's real `hydrateRoot` needs a live DOM; the suite runs in `node`. What
 * is under test here is hydratePage's ORDER and its failure guarantees — that
 * validation precedes the mount and that nothing touches `#vessel` when a step
 * fails — so the mount itself is stubbed and asserted on as a call.
 */
vi.mock("react-dom/client", () => ({ hydrateRoot: vi.fn() }));

/**
 * The defer-registry module reaches for `window`/`document` machinery this
 * suite's fake `document` does not provide (it is a minimal `getElementById`
 * stub, not a real DOM). What is under test here is only the WIRING —
 * whether `hydratePage` calls into the registry at the right time, with the
 * right arguments, when (and only when) `deferred` is present — so the
 * registry itself is mocked; its own behavior is covered by
 * `runtime/defer-registry.spec.ts`.
 */
vi.mock("./runtime/defer-registry", () => ({
  prepareDeferredPageData: vi.fn((pageData: Record<string, unknown>) => pageData),
  installStreamClosedRejection: vi.fn(),
}));

const SERVER_MARKUP = "<h1>server rendered</h1>";

const validPayload = {
  appData: null,
  layoutData: { title: "layout" },
  pageData: { title: "page" },
  shared: { locale: "en" },
  name: "main.home",
  locale: "en",
};

type FakeRoot = { id: string; innerHTML: string };

type FakeDocumentOptions = {
  payloadText?: string | null;
  withRoot?: boolean;
  withLegacyRoot?: boolean;
};

let root: FakeRoot;

function installFakeDocument(options: FakeDocumentOptions = {}): void {
  const {
    payloadText = stringify(validPayload),
    withRoot = true,
    withLegacyRoot = false,
  } = options;

  root = { id: HYDRATION_ROOT_ID, innerHTML: SERVER_MARKUP };

  vi.stubGlobal("document", {
    getElementById(id: string) {
      if (id === PAYLOAD_SCRIPT_ID) {
        return payloadText === null ? null : { textContent: payloadText };
      }

      if (id === HYDRATION_ROOT_ID) return withRoot ? root : null;

      if (id === "root") return withLegacyRoot ? { id: "root", innerHTML: SERVER_MARKUP } : null;

      return null;
    },
  });
}

/** Let the internal `then` chain settle without exposing it on the API. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function mountedTree(): ReactNode {
  const call = vi.mocked(hydrateRoot).mock.calls[0];

  if (call === undefined) throw new Error("hydrateRoot was never called.");

  const provider = call[1];

  if (!isValidElement(provider)) throw new Error("hydrateRoot received a non-element.");

  return (provider as ReactElement<{ children: ReactNode }>).props.children;
}

beforeEach(() => {
  vi.mocked(hydrateRoot).mockClear();
  vi.mocked(prepareDeferredPageData).mockClear();
  vi.mocked(installStreamClosedRejection).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("hydratePage", () => {
  it("mounts a synchronously built tree at #vessel", () => {
    installFakeDocument();

    hydratePage(() => "tree");

    expect(hydrateRoot).toHaveBeenCalledTimes(1);
    expect(vi.mocked(hydrateRoot).mock.calls[0]?.[0]).toBe(root);
    expect(mountedTree()).toBe("tree");
  });

  it("awaits a buildTree that returns a Promise, then mounts it", async () => {
    installFakeDocument();

    hydratePage(async () => "async tree");

    expect(hydrateRoot).not.toHaveBeenCalled();

    await settle();

    expect(hydrateRoot).toHaveBeenCalledTimes(1);
    expect(mountedTree()).toBe("async tree");
  });

  it("reads and validates the payload BEFORE calling buildTree", () => {
    installFakeDocument({ payloadText: "{ not json" });
    const buildTree = vi.fn(() => "tree");

    expect(() => hydratePage(buildTree)).toThrow(/could not be read/);
    expect(buildTree).not.toHaveBeenCalled();
  });

  it("hands buildTree the validated payload", () => {
    installFakeDocument();
    const buildTree = vi.fn(() => "tree");

    hydratePage(buildTree);

    expect(buildTree).toHaveBeenCalledWith(expect.objectContaining({ name: "main.home" }));
  });

  it("does not clear #vessel when buildTree rejects", async () => {
    installFakeDocument();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("chunk 404");

    hydratePage(() => Promise.reject(boom));

    await settle();

    expect(hydrateRoot).not.toHaveBeenCalled();
    expect(root.innerHTML).toBe(SERVER_MARKUP);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0]?.[0])).toContain("Warlock hydration failed");
    expect(consoleError.mock.calls[0]?.[1]).toBe(boom);
  });

  it("reports a rejected buildTree instead of leaving the rejection unhandled", async () => {
    installFakeDocument();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    hydratePage(() => Promise.reject(new Error("chunk 404")));

    await settle();
    process.off("unhandledRejection", unhandled);

    expect(unhandled).not.toHaveBeenCalled();
  });

  it("throws the ABSENT message and leaves the server markup alone", () => {
    installFakeDocument({ payloadText: null });

    expect(() => hydratePage(() => "tree")).toThrow(/payload is absent/);
    expect(hydrateRoot).not.toHaveBeenCalled();
    expect(root.innerHTML).toBe(SERVER_MARKUP);
  });

  it("throws the MALFORMED message when a required payload key is missing", () => {
    installFakeDocument({ payloadText: stringify({ ...validPayload, name: undefined }) });

    expect(() => hydratePage(() => "tree")).toThrow(/could not be read/);
    expect(hydrateRoot).not.toHaveBeenCalled();
  });

  it("throws when #vessel is absent", () => {
    installFakeDocument({ withRoot: false });

    expect(() => hydratePage(() => "tree")).toThrow(/no element with id "vessel"/);
    expect(hydrateRoot).not.toHaveBeenCalled();
  });

  it("names the 5.14 rename when the app still renders the legacy #root", () => {
    installFakeDocument({ withRoot: false, withLegacyRoot: true });

    expect(() => hydratePage(() => "tree")).toThrow(/renamed to "vessel" in 5\.14/);
  });

  it("does not mention the rename when no legacy #root exists", () => {
    installFakeDocument({ withRoot: false });

    expect(() => hydratePage(() => "tree")).not.toThrow(/renamed/);
  });

  it("throws for a missing #vessel before ever calling buildTree", () => {
    installFakeDocument({ withRoot: false });
    const buildTree = vi.fn(() => "tree");

    expect(() => hydratePage(buildTree)).toThrow(/no element with id "vessel"/);
    expect(buildTree).not.toHaveBeenCalled();
  });
});

describe("hydratePage — deferred payload wiring", () => {
  it("does not touch pageData or install the registry when `deferred` is absent", () => {
    installFakeDocument();
    const buildTree = vi.fn<BuildHydratedTree>(() => "tree");

    hydratePage(buildTree);

    const receivedPayload = buildTree.mock.calls[0]?.[0];

    expect(prepareDeferredPageData).not.toHaveBeenCalled();
    expect(installStreamClosedRejection).not.toHaveBeenCalled();
    expect(receivedPayload?.pageData).toEqual({ title: "page" });
  });

  it("prepares deferred pageData and arms stream-closed rejection when `deferred` is present", () => {
    installFakeDocument({
      payloadText: stringify({ ...validPayload, deferred: ["reviews"] }),
    });

    hydratePage(() => "tree");

    expect(prepareDeferredPageData).toHaveBeenCalledTimes(1);
    expect(prepareDeferredPageData).toHaveBeenCalledWith(
      expect.objectContaining({ title: "page" }),
      ["reviews"],
    );
    expect(installStreamClosedRejection).toHaveBeenCalledTimes(1);
  });

  it("still passes the completeness / hard-navigate check with `deferred` present (does not throw)", () => {
    installFakeDocument({
      payloadText: stringify({ ...validPayload, deferred: ["reviews"] }),
    });
    const buildTree = vi.fn(() => "tree");

    expect(() => hydratePage(buildTree)).not.toThrow();
    expect(buildTree).toHaveBeenCalledTimes(1);
    expect(hydrateRoot).toHaveBeenCalledTimes(1);
  });

  it("calls prepareDeferredPageData before installStreamClosedRejection, both before hydrateRoot", () => {
    installFakeDocument({
      payloadText: stringify({ ...validPayload, deferred: ["reviews"] }),
    });

    hydratePage(() => "tree");

    const prepareOrder = vi.mocked(prepareDeferredPageData).mock.invocationCallOrder[0];
    const installOrder = vi.mocked(installStreamClosedRejection).mock.invocationCallOrder[0];
    const mountOrder = vi.mocked(hydrateRoot).mock.invocationCallOrder[0];

    expect(prepareOrder).toBeLessThan(installOrder as number);
    expect(installOrder).toBeLessThan(mountOrder as number);
  });
});
