import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hydrateRoot } from "react-dom/client";
import { PAYLOAD_SCRIPT_ID } from "../components/document-context";
import { hydratePage } from "./hydrate-page";

/**
 * React's real `hydrateRoot` needs a live DOM; the suite runs in `node`. What
 * is under test here is hydratePage's ORDER and its failure guarantees — that
 * validation precedes the mount and that nothing touches `#root` when a step
 * fails — so the mount itself is stubbed and asserted on as a call.
 */
vi.mock("react-dom/client", () => ({ hydrateRoot: vi.fn() }));

const SERVER_MARKUP = "<h1>server rendered</h1>";

const validPayload = {
  appData: null,
  layoutData: { title: "layout" },
  pageData: { title: "page" },
  shared: { locale: "en" },
  name: "main.home",
};

type FakeRoot = { id: string; innerHTML: string };

type FakeDocumentOptions = {
  payloadText?: string | null;
  withRoot?: boolean;
};

let root: FakeRoot;

function installFakeDocument(options: FakeDocumentOptions = {}): void {
  const { payloadText = JSON.stringify(validPayload), withRoot = true } = options;

  root = { id: "root", innerHTML: SERVER_MARKUP };

  vi.stubGlobal("document", {
    getElementById(id: string) {
      if (id === PAYLOAD_SCRIPT_ID) {
        return payloadText === null ? null : { textContent: payloadText };
      }

      if (id === "root") return withRoot ? root : null;

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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("hydratePage", () => {
  it("mounts a synchronously built tree at #root", () => {
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

  it("does not clear #root when buildTree rejects", async () => {
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
    installFakeDocument({ payloadText: JSON.stringify({ ...validPayload, name: undefined }) });

    expect(() => hydratePage(() => "tree")).toThrow(/could not be read/);
    expect(hydrateRoot).not.toHaveBeenCalled();
  });

  it("throws when #root is absent", () => {
    installFakeDocument({ withRoot: false });

    expect(() => hydratePage(() => "tree")).toThrow(/no element with id "root"/);
    expect(hydrateRoot).not.toHaveBeenCalled();
  });

  it("throws for a missing #root before ever calling buildTree", () => {
    installFakeDocument({ withRoot: false });
    const buildTree = vi.fn(() => "tree");

    expect(() => hydratePage(buildTree)).toThrow(/no element with id "root"/);
    expect(buildTree).not.toHaveBeenCalled();
  });
});
