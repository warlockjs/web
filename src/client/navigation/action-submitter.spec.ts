import { afterEach, describe, expect, it, vi } from "vitest";

const submitPageAction = vi.fn();
const clearPrefetchCache = vi.fn();

vi.mock("./submit-page-action", () => ({
  submitPageAction: (...args: unknown[]) => submitPageAction(...args),
}));
vi.mock("./prefetch", () => ({ clearPrefetchCache: () => clearPrefetchCache() }));

import { createActionSubmitter } from "./action-submitter";
import { readSubmitting } from "./submitting-store";

const PAYLOAD = {
  appData: {},
  layoutData: {},
  pageData: {},
  shared: {},
  name: "contact",
  locale: "en",
  translations: {},
};

type Page = { payload: Record<string, unknown>; tree: unknown; routeSource: unknown };

function makeRuntime() {
  let current: Page = { payload: { ...PAYLOAD }, tree: "old", routeSource: PAYLOAD };
  let token = 0;
  const runtime = {
    readCurrent: () => current as never,
    writeCurrent: vi.fn((page: Page) => {
      current = page;
    }),
    buildTree: vi.fn(async () => "new" as never),
    claimTicket: () => {
      const mine = ++token;

      return { isCurrent: () => mine === token, signal: new AbortController().signal };
    },
    navigate: vi.fn(),
  };

  return { runtime, page: () => current, newerTicket: () => void runtime.claimTicket() };
}

afterEach(() => vi.clearAllMocks());

describe("createActionSubmitter", () => {
  it("swaps in the payload on success and clears the prefetch cache", async () => {
    const h = makeRuntime();

    submitPageAction.mockResolvedValue({ type: "payload", payload: PAYLOAD, url: "/c" });

    expect(await createActionSubmitter(h.runtime)("/c", new FormData())).toEqual({
      type: "success",
    });
    expect(h.runtime.writeCurrent).toHaveBeenCalledTimes(1);
    expect(h.page().tree).toBe("new");
    expect(clearPrefetchCache).toHaveBeenCalled();
    expect(readSubmitting()).toBe(false);
  });

  it("navigates on a redirect", async () => {
    const h = makeRuntime();

    submitPageAction.mockResolvedValue({ type: "redirect", url: "/thanks" });

    await createActionSubmitter(h.runtime)("/c", new FormData());

    expect(h.runtime.navigate).toHaveBeenCalledWith("/thanks");
    expect(h.runtime.writeCurrent).not.toHaveBeenCalled();
  });

  it("applies actionOnly without rebuilding the tree", async () => {
    const h = makeRuntime();

    submitPageAction.mockResolvedValue({ type: "actionOnly", actionData: { a: 1 }, status: 422 });

    await createActionSubmitter(h.runtime)("/c", new FormData());

    expect(h.runtime.buildTree).not.toHaveBeenCalled();
    expect(h.page().tree).toBe("old");
    expect(h.page().payload.actionData).toEqual({ a: 1 });
  });

  it("shares one request between a double submit", async () => {
    const h = makeRuntime();

    submitPageAction.mockResolvedValue({ type: "payload", payload: PAYLOAD, url: "/c" });

    const submit = createActionSubmitter(h.runtime);
    const first = submit("/c", new FormData());
    const second = submit("/c", new FormData());

    expect(second).toBe(first);
    await first;
    expect(submitPageAction).toHaveBeenCalledTimes(1);
  });

  it("drops the result when a navigation claimed a newer ticket", async () => {
    const h = makeRuntime();
    let resolve: (value: unknown) => void = () => undefined;

    submitPageAction.mockReturnValue(new Promise((r) => (resolve = r)));

    const pending = createActionSubmitter(h.runtime)("/c", new FormData());

    h.newerTicket();
    resolve({ type: "payload", payload: PAYLOAD, url: "/c" });

    expect(await pending).toEqual({ type: "dropped" });
    expect(h.runtime.writeCurrent).not.toHaveBeenCalled();
    expect(clearPrefetchCache).not.toHaveBeenCalled();
  });

  it("keeps the page and reports failed on a hard-fail", async () => {
    const h = makeRuntime();

    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    submitPageAction.mockResolvedValue({ type: "hard-fail", reason: "status 500" });

    expect(await createActionSubmitter(h.runtime)("/c", new FormData())).toEqual({
      type: "failed",
      reason: "status 500",
    });
    expect(h.runtime.writeCurrent).not.toHaveBeenCalled();
  });
});
